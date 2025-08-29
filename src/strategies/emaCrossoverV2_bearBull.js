import { ema } from '../utils/ema.js';

/**
 * EMA crossover v2 (bear/bull tuned)
 * - longOnly toggle (false enables shorts)
 * - side-specific enter/exit thresholds
 * - optional breakout confirmation to reduce bear squeezes
 */

/* How to use it in src/index.js: 
import { createStrategy as createEmaV2BearBull } from './strategies/emaCrossoverV2_bearBull.js';

strategiesBySymbol[symbol] = createEmaV2BearBull({
  fastPeriod: cfg.FAST_EMA,
  slowPeriod: cfg.SLOW_EMA,
  baseNotional: cfg.BASE_NOTIONAL,
  longOnly: false,            // <-- enable shorts
  enterBpsLong: 20, exitBpsLong: 10,
  enterBpsShort: 25, exitBpsShort: 12,  // stricter shorts
  minHoldMs: 2 * 60 * 1000,
  cooldownMs: 30 * 1000,
  volLookback: 60, volK: 1.5,
  breakoutLookback: 0,        // set to e.g. 60 to require n-tick breakout
  breakoutBps: 5
}); 
*/


export function createStrategy({
  fastPeriod = 20,
  slowPeriod = 60,
  baseNotional = 100,

  // side-specific base thresholds in bps
  enterBpsLong = 20,
  exitBpsLong  = 10,
  enterBpsShort = 25,   // stricter for shorts
  exitBpsShort  = 12,

  longOnly = false,

  // churn guards
  minHoldMs = 2 * 60 * 1000,
  cooldownMs = 30 * 1000,

  // volatility adaptation (bps of abs returns)
  volLookback = 60,
  volK = 1.5,

  // optional breakout filter (disabled if lookback <= 0)
  breakoutLookback = 0,   // e.g., 60 ticks
  breakoutBps = 5         // require mark < (recentLow * (1 - 5 bps)) for shorts; inverse for longs
} = {}) {
  let fast = null, slow = null;
  let prevSlow = null;
  let lastState = 'flat'; // 'flat' | 'long' | 'short'
  let entryTs = 0, lastExitTs = 0;

  let lastMark = null;
  let volEwmaBps = null;

  // ring buffer for breakout check
  const buf = [];
  const pushMark = (m) => {
    if (breakoutLookback <= 0) return;
    buf.push(m);
    if (buf.length > breakoutLookback) buf.shift();
  };

  function onPrice({ mark }) {
    // volatility EWMA (in bps)
    if (lastMark != null) {
      const retBps = Math.abs((mark - lastMark) / lastMark) * 1e4;
      const kVol = 2 / (volLookback + 1);
      volEwmaBps = (volEwmaBps == null) ? retBps : volEwmaBps + kVol * (retBps - volEwmaBps);
    }
    pushMark(mark);
    lastMark = mark;

    // EMAs
    const kf = 2 / (fastPeriod + 1);
    const ks = 2 / (slowPeriod + 1);
    fast = (fast == null) ? mark : fast + kf * (mark - fast);
    const prevSlowLocal = slow;
    slow = (slow == null) ? mark : slow + ks * (mark - slow);
    if (prevSlowLocal == null) { prevSlow = slow; return { action: null }; }
    const slowSlopeBps = ((slow - prevSlowLocal) / mark) * 1e4;
    prevSlow = prevSlowLocal;

    const delta = fast - slow;
    const deltaBps = (delta / mark) * 1e4;

    // dynamic thresholds (ensure >= base)
    const dynEnterLong  = Math.max(enterBpsLong,  (volEwmaBps ?? 0) * volK);
    const dynExitLong   = Math.max(exitBpsLong,   (volEwmaBps ?? 0) * volK * 0.5);
    const dynEnterShort = Math.max(enterBpsShort, (volEwmaBps ?? 0) * volK);
    const dynExitShort  = Math.max(exitBpsShort,  (volEwmaBps ?? 0) * volK * 0.5);

    const now = Date.now();
    const canExit = (now - entryTs) >= minHoldMs;
    const cooled  = (now - lastExitTs) >= cooldownMs;

    // optional breakout checks
    let longOK = true, shortOK = true;
    if (breakoutLookback > 0 && buf.length >= 2) {
      const recentLow  = Math.min(...buf);
      const recentHigh = Math.max(...buf);
      if (longOnly || true) {
        const threshUp = recentHigh * (1 - breakoutBps / 1e4);
        longOK = (mark >= threshUp); // near highs
      }
      const threshDn = recentLow * (1 + breakoutBps / 1e4);
      shortOK = (mark <= threshDn);  // near lows
    }

    // --- State machine ---
    if (lastState === 'long') {
      if (deltaBps < -dynExitLong && canExit) {
        lastState = 'flat';
        lastExitTs = now;
        return { action: 'sell', baseNotional };
      }
      return { action: null };
    }

    if (lastState === 'short' && !longOnly) {
      if (deltaBps > dynExitShort && canExit) {
        lastState = 'flat';
        lastExitTs = now;
        return { action: 'buy', baseNotional };
      }
      return { action: null };
    }

    // flat: enter with regime + thresholds (+ optional breakout)
    if (deltaBps > dynEnterLong && slowSlopeBps > 0 && cooled && longOK) {
      lastState = 'long'; entryTs = now; return { action: 'buy', baseNotional };
    }
    if (!longOnly && deltaBps < -dynEnterShort && slowSlopeBps < 0 && cooled && shortOK) {
      lastState = 'short'; entryTs = now; return { action: 'sell', baseNotional };
    }
    return { action: null };
  }

  return { onPrice };
}
