import pkg from '@drift-labs/sdk';
const { PerpMarkets } = pkg;
import { resolveMarketIndex } from './resolveMarketIndex.js';

/**
 * Parse and clamp markets from env; resolve to indexes for subscription.
 * Returns { list: [{ symbol, marketIndex }], indexes: number[] }
 */
export async function buildMarketUniverse(cfg) {
  let symbols = (process.env.MARKETS || cfg.MARKET_SYMBOL || 'SOL-PERP')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const max = Math.max(1, Number(process.env.MAX_MARKETS || 1));
  if (symbols.length > max) {
    symbols = symbols.slice(0, max);
  }

  const list = [];
  for (const symbol of symbols) {
    const idx = await resolveMarketIndex(cfg.ENV_NETWORK, symbol, PerpMarkets);
    list.push({ symbol, marketIndex: idx });
  }

  const indexes = list.map(x => x.marketIndex);
  return { list, indexes };
}
