// src/markets/universe.js
import pkg from '@drift-labs/sdk';
const { PerpMarkets } = pkg;
import { resolveMarketIndex } from './resolveMarketIndex.js';

export async function buildMarketUniverse(cfg) {
  const raw = (process.env.MARKETS || cfg.MARKET_SYMBOL || 'SOL-PERP').trim();
  let symbols;

  if (raw.toUpperCase() === 'ALL') {
    // pull all from SDK constants for the env
    const table = PerpMarkets?.[cfg.ENV_NETWORK] || [];
    symbols = table.map(m => m.symbol);
  } else {
    symbols = raw.split(',').map(s => s.trim()).filter(Boolean);
  }

  // safety clamp to avoid 413s on small RPC plans
  const max = Math.max(1, Number(process.env.MAX_MARKETS || 1));
  if (symbols.length > max) symbols = symbols.slice(0, max);

  const list = [];
  for (const symbol of symbols) {
    const idx = await resolveMarketIndex(cfg.ENV_NETWORK, symbol, PerpMarkets);
    list.push({ symbol, marketIndex: idx });
  }
  return { list, indexes: list.map(x => x.marketIndex) };
}
