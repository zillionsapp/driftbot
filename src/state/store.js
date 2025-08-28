import fs from 'fs';
import { nowIso } from '../utils/time.js';

export async function createStore(cfg, log) {
  function load() {
    if (cfg.RESET_STATE) return null;
    try {
      if (fs.existsSync(cfg.STATE_FILE)) {
        const txt = fs.readFileSync(cfg.STATE_FILE, 'utf-8');
        return JSON.parse(txt);
      }
    } catch (e) {
      log.warn(`Failed to read state file: ${e.message}`);
    }
    return null;
  }
  function save(state) {
    try {
      fs.writeFileSync(cfg.STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
      log.warn(`Failed to write state file: ${e.message}`);
    }
  }

  const persisted = load();
  const state = persisted || {
    meta: {
      createdAt: nowIso(),
      network: cfg.ENV_NETWORK,
      notes: 'paper trading state (multi-market)'
    },
    deposit: cfg.INITIAL_DEPOSIT,
    cash: cfg.INITIAL_DEPOSIT,
    markets: {} // keyed by symbol
  };

  function ensureMarket(symbol) {
    if (!state.markets[symbol]) {
      state.markets[symbol] = {
        position: 0,
        entryPrice: 0,
        realizedPnL: 0,
        feesPaid: 0,
        trades: []
      };
    }
    return state.markets[symbol];
  }

  const api = {
    get: () => state,
    ensureMarket,
    save: () => save(state),
    recordTrade: (symbol, trade) => {
      ensureMarket(symbol).trades.push(trade);
      save(state);
    }
  };

  return api;
}
