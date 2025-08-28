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
    STATE_FILE: statePath,
    RESET_STATE,
    INITIAL_DEPOSIT,
    ACCOUNT_SUB_TYPE,
    NODE_ENV: process.env.NODE_ENV || 'production'
  };
}
