// Adaptive EMA: bull & bear, cost-aware, volatility-adaptive, optional breakout filter
export function createStrategy({
  fastPeriod = 20,
  slowPeriod = 60,
  baseNotional = 100,

  // side-specific base thresholds in bps (1bp = 0.01%)
  enterBpsLong = 20, exitBpsLong = 10,
  enterBpsShort = 28, exitBpsShort = 12,   // shorts a bit stricter

  longOnly = false,

  // churn guards
  minHoldMs = 2 * 60 * 1000,
  cooldownMs = 30 * 1000,

  // volatility adaptation (EWMA of abs returns, in bps)
  volLookback = 60,
  volK = 1.5,

  // breakout filter (0 disables)
  breakoutLookback = 0,   // e.g. 60 ticks
  breakoutBps = 5         // need 5bp beyond recent extreme
} = {}) {
  let fast = null, slow = null, prevSlow = null;
  let lastState = 'flat';          // 'flat' | 'long' | 'short'
  let entryTs = 0, lastExitTs = 0;
  let lastMark = null, volEwmaBps = null;

  // ring buffer for breakout
  const buf = [];
  const push = (m) => {
    if (breakoutLookback <= 0) return;
    buf.push(m);
    if (buf.length > breakoutLookback) buf.shift();
  };

  function onPrice({ mark }) {
    // --- volatility EWMA (bps) ---
    if (lastMark != null) {
      const retBps = Math.abs((mark - lastMark) / lastMark) * 1e4;
      const kv = 2 / (volLookback + 1);
      volEwmaBps = (volEwmaBps == null) ? retBps : volEwmaBps + kv * (retBps - volEwmaBps);
    }
    lastMark = mark; push(mark);

    // --- EMAs ---
    const kf = 2 / (fastPeriod + 1);
    const ks = 2 / (slowPeriod + 1);
    fast = (fast == null) ? mark : fast + kf * (mark - fast);
    const prevSlowLocal = slow;
    slow = (slow == null) ? mark : slow + ks * (mark - slow);
    if (prevSlowLocal == null) { prevSlow = slow; return { action: null, baseNotional }; }

    // signal features
    const delta = fast - slow;
    const deltaBps = (delta / mark) * 1e4;
    const slowSlopeBps = ((slow - prevSlowLocal) / mark) * 1e4;   // regime proxy

    // dynamic thresholds (>= base)
    const dynEnterLong  = Math.max(enterBpsLong,  (volEwmaBps ?? 0) * volK);
    const dynExitLong   = Math.max(exitBpsLong,   (volEwmaBps ?? 0) * volK * 0.5);
    const dynEnterShort = Math.max(enterBpsShort, (volEwmaBps ?? 0) * volK);
    const dynExitShort  = Math.max(exitBpsShort,  (volEwmaBps ?? 0) * volK * 0.5);

    // optional breakout filter to avoid shorting into squeezes / buying into fades
    let longOK = true, shortOK = true;
    if (breakoutLookback > 0 && buf.length >= 2) {
      const recentLow  = Math.min(...buf);
      const recentHigh = Math.max(...buf);
      const upThresh   = recentHigh * (1 - breakoutBps / 1e4);
      const dnThresh   = recentLow  * (1 + breakoutBps / 1e4);
      longOK  = mark >= upThresh;
      shortOK = mark <= dnThresh;
    }

    const now = Date.now();
    const canExit = (now - entryTs) >= minHoldMs;
    const cooled  = (now - lastExitTs) >= cooldownMs;

    // --- State machine ---
    if (lastState === 'long') {
      // exit only on meaningful bearish signal
      if (deltaBps < -dynExitLong && canExit) {
        lastState = 'flat'; lastExitTs = now;
        return { action: 'sell', baseNotional }; // exit long
      }
      return { action: null, baseNotional };
    }

    if (lastState === 'short' && !longOnly) {
      if (deltaBps > dynExitShort && canExit) {
        lastState = 'flat'; lastExitTs = now;
        return { action: 'buy', baseNotional }; // exit short
      }
      return { action: null, baseNotional };
    }

    // flat: regime-aligned entries
    const bullish = slowSlopeBps > 0;
    const bearish = slowSlopeBps < 0;

    if (deltaBps > dynEnterLong && bullish && cooled && longOK) {
      lastState = 'long'; entryTs = now;
      return { action: 'buy', baseNotional };       // enter long
    }
    if (!longOnly && deltaBps < -dynEnterShort && bearish && cooled && shortOK) {
      lastState = 'short'; entryTs = now;
      return { action: 'sell', baseNotional };      // enter short
    }

    return { action: null, baseNotional };
  }

  return { onPrice };
}
