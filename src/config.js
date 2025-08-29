import path from 'path';
import { fileURLToPath } from 'url';

export function createConfig() {
  const ENV_NETWORK = (process.env.NETWORK || 'mainnet-beta').toLowerCase();
  const RPC_URL = process.env.RPC_URL || '';
  const WS_URL = process.env.WS_URL || '';
  const MARKET_SYMBOL = process.env.MARKET_SYMBOL || 'SOL-PERP'; // default single symbol
  const MARKETS_ENV = (process.env.MARKETS || MARKET_SYMBOL).split(',').map(s => s.trim()).filter(Boolean);
  const MAX_MARKETS = Math.max(1, Number(process.env.MAX_MARKETS || 1));

  const BASE_NOTIONAL = Number(process.env.BASE_NOTIONAL || 100);
  const FAST_EMA = Number(process.env.FAST_EMA || 20);
  const SLOW_EMA = Number(process.env.SLOW_EMA || 60);

  const LOG_EVERY_MS = Number(process.env.LOG_EVERY_MS || 10000);
  const TICK_MS = Number(process.env.TICK_MS || 1000);
  const MIN_MARK_MOVE_BPS = Number(process.env.MIN_MARK_MOVE_BPS || 1); // 1 bp = 0.01%
  const TICK_JITTER_MS = Number(process.env.TICK_JITTER_MS || 0);       // optional random jitter

  const STATE_FILE = process.env.STATE_FILE || './state.json';
  const RESET_STATE = String(process.env.RESET_STATE || 'false').toLowerCase() === 'true';
  const INITIAL_DEPOSIT = Number(process.env.INITIAL_DEPOSIT || 10000);
  const ACCOUNT_SUB_TYPE = (process.env.ACCOUNT_SUB_TYPE || 'websocket').toLowerCase();

  if (!RPC_URL) throw new Error('CONFIG: RPC_URL is required');
  if (!['websocket','polling'].includes(ACCOUNT_SUB_TYPE)) {
    throw new Error('CONFIG: ACCOUNT_SUB_TYPE must be websocket or polling');
  }
  if (SLOW_EMA <= FAST_EMA) throw new Error('CONFIG: SLOW_EMA must be greater than FAST_EMA');

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const statePath = path.isAbsolute(STATE_FILE) ? STATE_FILE : path.join(__dirname, '..', STATE_FILE);

  return {
    ENV_NETWORK,
    RPC_URL, WS_URL,
    MARKET_SYMBOL,
    MARKETS_ENV, MAX_MARKETS,
    BASE_NOTIONAL, FAST_EMA, SLOW_EMA,
    LOG_EVERY_MS, TICK_MS, 
    MIN_MARK_MOVE_BPS, 
    TICK_JITTER_MS,
    STATE_FILE: statePath,
    RESET_STATE,
    INITIAL_DEPOSIT,
    ACCOUNT_SUB_TYPE,
    NODE_ENV: process.env.NODE_ENV || 'production',
    STRAT_EMA: {
      fastPeriod: FAST_EMA,
      slowPeriod: SLOW_EMA,
      baseNotional: BASE_NOTIONAL,
      longOnly: String(process.env.LONG_ONLY || 'false') !== 'false', // default false
      enterBpsLong: Number(process.env.ENTER_BPS_LONG || 20),
      exitBpsLong: Number(process.env.EXIT_BPS_LONG || 10),
      enterBpsShort: Number(process.env.ENTER_BPS_SHORT || 28),
      exitBpsShort: Number(process.env.EXIT_BPS_SHORT || 12),
      minHoldMs: Number(process.env.MIN_HOLD_MS || 120000),
      cooldownMs: Number(process.env.COOLDOWN_MS || 30000),
      volLookback: Number(process.env.VOL_LOOKBACK || 60),
      volK: Number(process.env.VOL_K || 1.5),
      breakoutLookback: Number(process.env.BREAKOUT_LOOKBACK || 0),
      breakoutBps: Number(process.env.BREAKOUT_BPS || 5),
      minWarmTicks: Number(process.env.MIN_WARM_TICKS || (2 * SLOW_EMA)),
    }
  };
}
