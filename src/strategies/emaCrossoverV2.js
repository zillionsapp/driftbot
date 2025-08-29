import { ema } from '../utils/ema.js';

/**
 * EMA crossover v2 — cost-aware, long-only by default, adaptive thresholds,
 * state machine (flat/long[/short]), min-hold & cooldown to prevent churn.
 */
export function createStrategy({
  fastPeriod = 20,
  slowPeriod = 60,
  baseNotional = 100,

  // thresholds in bps (1 bp = 0.01%)
  enterBps = 20,          // require ~0.20% advantage to enter
  exitBps  = 10,          // ~0.10% to exit
  longOnly = true,        // set false to allow shorts

  // churn guards
  minHoldMs = 2 * 60 * 1000,   // hold >= 2 min before exit
  cooldownMs = 30 * 1000,      // 30s cooldown after exit

  // volatility adaptation (bps of absolute returns)
  volLookback = 60,       // EWMA length (ticks)
  volK = 1.5              // dynamic boost factor
} = {}) {
  let fast = null, slow = null;
  let prevFast = null, prevSlow = null;
  let lastState = 'flat';      // 'flat' | 'long' | 'short'
  let entryTs = 0, lastExitTs = 0;

  let lastMark = null;
  let volEwmaBps = null;       // EWMA of absolute return (in bps)

  function onPrice({ mark }) {
    // --- volatility EWMA in bps ---
    if (lastMark != null) {
      const retBps = Math.abs((mark - lastMark) / lastMark) * 1e4;
      const kVol = 2 / (volLookback + 1);
      volEwmaBps = (volEwmaBps == null) ? retBps : volEwmaBps + kVol * (retBps - volEwmaBps);
    }
    lastMark = mark;

    // --- EMAs ---
    const kf = 2 / (fastPeriod + 1);
    const ks = 2 / (slowPeriod + 1);
    prevFast = fast; prevSlow = slow;
    fast = (fast == null) ? mark : fast + kf * (mark - fast);
    slow = (slow == null) ? mark : slow + ks * (mark - slow);
    if (prevFast == null || prevSlow == null) return { action: null };

    const delta = fast - slow;
    const deltaBps = (delta / mark) * 1e4;
    const slowSlopeBps = ((slow - prevSlow) / mark) * 1e4;

    // dynamic thresholds (ensure >= base)
    const dynEnter = Math.max(enterBps, (volEwmaBps ?? 0) * volK);
    const dynExit  = Math.max(exitBps,  (volEwmaBps ?? 0) * volK * 0.5);

    const now = Date.now();
    const canExit = (now - entryTs) >= minHoldMs;
    const cooled  = (now - lastExitTs) >= cooldownMs;

    // --- State machine ---
    if (lastState === 'long') {
      // exit long only when signal meaningfully reverses
      if (deltaBps < -dynExit && canExit) {
        lastState = 'flat';
        lastExitTs = now;
        return { action: 'sell', baseNotional };
      }
      return { action: null };
    }

    if (lastState === 'short' && !longOnly) {
      if (deltaBps > dynExit && canExit) {
        lastState = 'flat';
        lastExitTs = now;
        return { action: 'buy', baseNotional };
      }
      return { action: null };
    }

    // currently flat: only enter with buffer + trend alignment
    if (longOnly) {
      if (deltaBps > dynEnter && slowSlopeBps > 0 && cooled) {
        lastState = 'long';
        entryTs = now;
        return { action: 'buy', baseNotional };
      }
      return { action: null };
    } else {
      if (deltaBps > dynEnter && slowSlopeBps > 0 && cooled) {
        lastState = 'long'; entryTs = now; return { action: 'buy', baseNotional };
      }
      if (deltaBps < -dynEnter && slowSlopeBps < 0 && cooled) {
        lastState = 'short'; entryTs = now; return { action: 'sell', baseNotional };
      }
      return { action: null };
    }
  }

  return { onPrice };
}
