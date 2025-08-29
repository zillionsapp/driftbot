// src/strategies/emaAdaptive.js
//
// Adaptive EMA strategy (bull & bear), cost/vol-aware, with warmup.
// SINGLE SOURCE OF TRUTH: all knobs come from the cfg object you pass in.
// The ONLY implicit default is minWarmTicks (derived if omitted).
//
// Expected cfg shape (all required unless noted):
// {
//   fastPeriod, slowPeriod, baseNotional,
//   enterBpsLong, exitBpsLong, enterBpsShort, exitBpsShort,
//   longOnly,                 // boolean
//   minHoldMs, cooldownMs,
//   volLookback, volK,
//   breakoutLookback,         // set 0 to disable
//   breakoutBps,              // set 0 if not using breakout
//   minWarmTicks?,            // optional; if missing -> max(2*slowPeriod, 200)
//   seed?: { fast?, slow?, volEwmaBps?, lastMark? } // optional
// }

export function createStrategy(cfg) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('createStrategy requires a configuration object (use cfg.STRAT_EMA)');
  }

  // Validate required fields (except minWarmTicks & seed which are optional)
  const required = [
    'fastPeriod','slowPeriod','baseNotional',
    'enterBpsLong','exitBpsLong','enterBpsShort','exitBpsShort',
    'longOnly','minHoldMs','cooldownMs',
    'volLookback','volK','breakoutLookback','breakoutBps'
  ];
  for (const k of required) {
    if (cfg[k] === undefined || cfg[k] === null) {
      throw new Error(`Strategy config missing required key: ${k}`);
    }
  }

  // Pull from cfg (single source of truth)
  const {
    fastPeriod, slowPeriod, baseNotional,
    enterBpsLong, exitBpsLong, enterBpsShort, exitBpsShort,
    longOnly,
    minHoldMs, cooldownMs,
    volLookback, volK,
    breakoutLookback, breakoutBps,
    minWarmTicks,           // optional
    seed = {}               // optional
  } = cfg;

  // Only derived fallback we allow (not a separate config!)
  const warmTicks = Number.isFinite(minWarmTicks)
    ? Math.max(1, minWarmTicks)
    : Math.max(2 * slowPeriod, 200);

  // --- internal state (seedable) ---
  let fast   = Number.isFinite(seed.fast)       ? seed.fast       : null;
  let slow   = Number.isFinite(seed.slow)       ? seed.slow       : null;
  let lastMark    = Number.isFinite(seed.lastMark)    ? seed.lastMark    : null;
  let volEwmaBps  = Number.isFinite(seed.volEwmaBps) ? seed.volEwmaBps  : null;
  let prevSlow = null;

  let lastState = 'flat'; // 'flat' | 'long' | (if !longOnly) 'short'
  let entryTs = 0, lastExitTs = 0;
  let ticks = 0;

  // Ring buffer for optional breakout confirmation
  const buf = [];
  const pushMark = (m) => {
    if (breakoutLookback <= 0) return;
    buf.push(m);
    if (buf.length > breakoutLookback) buf.shift();
  };

  function onPrice({ mark }) {
    if (!Number.isFinite(mark)) return { action: null, baseNotional };

    // --- volatility EWMA (in bps) ---
    if (lastMark != null) {
      const retBps = Math.abs((mark - lastMark) / lastMark) * 1e4;
      const kVol = 2 / (volLookback + 1);
      volEwmaBps = (volEwmaBps == null) ? retBps : (volEwmaBps + kVol * (retBps - volEwmaBps));
    }
    lastMark = mark;
    pushMark(mark);

    // --- EMAs ---
    const kf = 2 / (fastPeriod + 1);
    const ks = 2 / (slowPeriod + 1);
    fast = (fast == null) ? mark : fast + kf * (mark - fast);
    const prevSlowLocal = slow;
    slow = (slow == null) ? mark : slow + ks * (mark - slow);

    ticks++;
    // need at least one prior slow to compute slope; and warmup complete
    if (prevSlowLocal == null || ticks < warmTicks) {
      prevSlow = slow;
      return { action: null, baseNotional };
    }

    // --- features ---
    const delta = fast - slow;
    const deltaBps = (delta / mark) * 1e4;
    const slowSlopeBps = ((slow - prevSlowLocal) / mark) * 1e4; // regime proxy
    prevSlow = prevSlowLocal;

    // dynamic thresholds (>= base)
    const dynEnterLong  = Math.max(enterBpsLong,  (volEwmaBps ?? 0) * volK);
    const dynExitLong   = Math.max(exitBpsLong,   (volEwmaBps ?? 0) * volK * 0.5);
    const dynEnterShort = Math.max(enterBpsShort, (volEwmaBps ?? 0) * volK);
    const dynExitShort  = Math.max(exitBpsShort,  (volEwmaBps ?? 0) * volK * 0.5);

    // optional breakout confirmation (set breakoutLookback=0 to disable)
    let longOK = true, shortOK = true;
    if (breakoutLookback > 0 && buf.length >= 2) {
      const recentLow  = Math.min(...buf);
      const recentHigh = Math.max(...buf);
      const upThresh = recentHigh * (1 - breakoutBps / 1e4); // near highs for longs
      const dnThresh = recentLow  * (1 + breakoutBps / 1e4); // near lows for shorts
      longOK  = mark >= upThresh;
      shortOK = mark <= dnThresh;
    }

    const now = Date.now();
    const canExit = (now - entryTs) >= minHoldMs;
    const cooled  = (now - lastExitTs) >= cooldownMs;

    // --- state machine ---
    if (lastState === 'long') {
      if (deltaBps < -dynExitLong && canExit) {
        lastState = 'flat';
        lastExitTs = now;
        return { action: 'sell', baseNotional }; // exit long
      }
      return { action: null, baseNotional };
    }

    if (lastState === 'short' && !longOnly) {
      if (deltaBps > dynExitShort && canExit) {
        lastState = 'flat';
        lastExitTs = now;
        return { action: 'buy', baseNotional }; // exit short
      }
      return { action: null, baseNotional };
    }

    // flat: regime-aligned entries with dynamic thresholds (+ optional breakout)
    const bullish = slowSlopeBps > 0;
    const bearish = slowSlopeBps < 0;

    if (deltaBps > dynEnterLong && bullish && cooled && longOK) {
      lastState = 'long';
      entryTs = now;
      return { action: 'buy', baseNotional }; // enter long
    }
    if (!longOnly && deltaBps < -dynEnterShort && bearish && cooled && shortOK) {
      lastState = 'short';
      entryTs = now;
      return { action: 'sell', baseNotional }; // enter short
    }

    return { action: null, baseNotional };
  }

  // Optional: snapshot internal state for debugging/persistence
  function snapshot() {
    return {
      fast, slow, prevSlow,
      lastState, entryTs, lastExitTs,
      lastMark, volEwmaBps, ticks, warmTicks
    };
  }

  return { onPrice, snapshot };
}
