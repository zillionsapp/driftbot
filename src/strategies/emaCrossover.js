import { ema } from '../utils/ema.js';

/**
 * Simple EMA crossover with 5 bps hysteresis.
 * Returns signals: 'buy', 'sell', or null.
 */
export function createStrategy({ fastPeriod = 20, slowPeriod = 60, baseNotional = 100 } = {}) {
  let fast = null, slow = null;

  function onPrice({ mark }) {
    fast = ema(fast, mark, fastPeriod);
    slow = ema(slow, mark, slowPeriod);

    if (fast && slow) {
      const delta = fast - slow;
      const threshold = mark * 0.0005; // 5 bps
      if (delta > threshold) return { action: 'buy', baseNotional };
      if (delta < -threshold) return { action: 'sell', baseNotional };
    }
    return { action: null };
  }

  return { onPrice };
}
