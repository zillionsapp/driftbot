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
      market: cfg.MARKET_SYMBOL,
      notes: 'paper trading state'
    },
    deposit: cfg.INITIAL_DEPOSIT,
    cash: cfg.INITIAL_DEPOSIT,
    position: 0,
    entryPrice: 0,
    realizedPnL: 0,
    feesPaid: 0,
    trades: []
  };

  const api = {
    get: () => state,
    save: () => save(state),
    recordTrade: (trade) => {
      state.trades.push(trade);
      save(state);
    }
  };

  return api;
}
