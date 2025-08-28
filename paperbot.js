// paperbot.js — ESM, Node 18+
// Paper trading on Drift mainnet with JSON persistence (no devnet fallback).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Connection, Keypair } from '@solana/web3.js';
import pkg from '@drift-labs/sdk';

const {
  DriftClient,
  initialize,
  convertToNumber,
  PerpMarkets,
  calculateBidAskPrice,
  PRICE_PRECISION,
} = pkg;

// ---------- config ----------
const ENV_NETWORK = (process.env.NETWORK || 'mainnet-beta').toLowerCase();
const RPC_URL = process.env.RPC_URL || '';
const WS_URL = process.env.WS_URL || ''; // many providers require a separate WS URL
const MARKET_SYMBOL = process.env.MARKET_SYMBOL || 'SOL-PERP';
const BASE_NOTIONAL = Number(process.env.BASE_NOTIONAL || 100);
const FAST_EMA = Number(process.env.FAST_EMA || 20);
const SLOW_EMA = Number(process.env.SLOW_EMA || 60);
const LOG_EVERY_MS = Number(process.env.LOG_EVERY_MS || 10000);
const STATE_FILE = process.env.STATE_FILE || './state.json';
const RESET_STATE = String(process.env.RESET_STATE || 'false').toLowerCase() === 'true';
const INITIAL_DEPOSIT = Number(process.env.INITIAL_DEPOSIT || 10000);

if (!RPC_URL) {
  console.error('CONFIG ERROR: RPC_URL is required. Use a provider mainnet endpoint that allows getProgramAccounts & websockets.');
  process.exit(1);
}
if (SLOW_EMA <= FAST_EMA) {
  console.error('CONFIG ERROR: SLOW_EMA must be greater than FAST_EMA');
  process.exit(1);
}

// ---------- utils ----------
const now = () => new Date().toISOString();
const ema = (prev, price, period) => {
  const k = 2 / (period + 1);
  return prev == null ? price : prev + k * (price - prev);
};

// ---------- state (semi-DB) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const statePath = path.isAbsolute(STATE_FILE) ? STATE_FILE : path.join(__dirname, STATE_FILE);

function loadState() {
  if (RESET_STATE) return null;
  try {
    if (fs.existsSync(statePath)) {
      const txt = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(txt);
    }
  } catch (e) {
    console.warn(`[${now()}] WARN: Failed to read state file: ${e.message}`);
  }
  return null;
}

function saveState(state) {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`[${now()}] WARN: Failed to write state file: ${e.message}`);
  }
}

// initialize state
const persisted = loadState();
const state = persisted || {
  meta: {
    createdAt: now(),
    network: ENV_NETWORK,
    market: MARKET_SYMBOL,
    notes: 'paper trading state',
  },
  deposit: INITIAL_DEPOSIT,
  cash: INITIAL_DEPOSIT,
  position: 0,          // base units
  entryPrice: 0,        // VWAP entry
  realizedPnL: 0,
  feesPaid: 0,
  trades: [],           // {t, side, qty, px, notional}
};

// ---------- paper execution model ----------
const feeBps = 2;     // 2 bps per side
const slippageBps = 1; // 1 bps slippage

function applyFee(notional) {
  const fee = (feeBps / 1e4) * Math.abs(notional);
  state.feesPaid += fee;
  state.cash -= fee;
}

function slip(price, side) {
  const s = (slippageBps / 1e4) * price;
  return side === 'buy' ? price + s : price - s;
}

function markToMarketPx(markPrice) {
  if (state.position === 0) return 0;
  const pnlPerUnit = (markPrice - state.entryPrice) * Math.sign(state.position);
  return pnlPerUnit * Math.abs(state.position);
}

function recordTrade(side, qty, px) {
  state.trades.push({
    t: now(),
    side,
    qty,
    px,
    notional: px * qty * (side === 'sell' ? 1 : -1),
  });
  saveState(state);
}

function paperFill(side, qty, markPrice) {
  if (qty <= 0) return;
  const px = slip(markPrice, side);
  const notional = px * qty;

  // cash
  if (side === 'buy') state.cash -= notional;
  else state.cash += notional;

  // fees
  applyFee(notional);

  // position V(W)AP & realized
  const prevPos = state.position;
  const newPos = prevPos + (side === 'buy' ? qty : -qty);

  if (prevPos === 0 || Math.sign(prevPos) === Math.sign(newPos)) {
    // increase / same side
    const totalCost = state.entryPrice * Math.abs(prevPos) + px * qty;
    const newQtyAbs = Math.abs(newPos);
    state.entryPrice = newQtyAbs > 0 ? totalCost / newQtyAbs : 0;
  } else {
    // reduce/close/flip
    const closingQty = Math.min(Math.abs(prevPos), qty);
    const realized = (px - state.entryPrice) * Math.sign(prevPos) * closingQty;
    state.realizedPnL += realized;

    if (Math.abs(newPos) > 0 && Math.sign(newPos) !== Math.sign(prevPos)) {
      // flipped
      state.entryPrice = px;
    } else if (newPos === 0) {
      state.entryPrice = 0;
    }
  }

  state.position = newPos;
  recordTrade(side, qty, px);
}

// ---------- market resolution ----------
async function resolveMarketIndex(env, marketSymbol) {
  const tables = [
    PerpMarkets?.[env],
    PerpMarkets?.['mainnet-beta'],
    PerpMarkets?.['mainnet'],
  ].filter(Boolean);

  if (tables.length === 0) {
    throw new Error('PerpMarkets table not available in SDK build');
  }

  const baseSymbol = marketSymbol.replace(/-PERP$/i, '');
  for (const tbl of tables) {
    const m =
      tbl.find((x) => x.baseAssetSymbol === baseSymbol) ||
      tbl.find(
        (x) =>
          x.symbol === marketSymbol ||
          x.marketName === marketSymbol ||
          x.baseAssetSymbol === baseSymbol
      );
    if (m && typeof m.marketIndex === 'number') return m.marketIndex;
  }
  throw new Error(`Perp market ${marketSymbol} not found in tables`);
}

// ---------- main ----------
async function main() {
  console.log(`[${now()}] starting drift paper bot on ${MARKET_SYMBOL}`);

  // Enforce mainnet & fail fast on 410/disabled
  const connOpts = { commitment: 'confirmed' };
  // Provide explicit wsEndpoint if available; many providers require it
  const connection = WS_URL
    ? new Connection(RPC_URL, connOpts, WS_URL)
    : new Connection(RPC_URL, connOpts);

  // Dummy wallet (never sends txs)
  const dummy = Keypair.generate();

  // Initialize SDK; pin env to what you want
  const sdkConfig = await initialize({ connection, env: ENV_NETWORK });
  const env = sdkConfig.env;
  if (env !== 'mainnet-beta') {
    console.warn(`[${now()}] WARN: Detected env ${env}. Proceeding anyway (paper only).`);
  }

  const marketIndex = await resolveMarketIndex(env, MARKET_SYMBOL);

  const drift = new DriftClient({
    connection,
    wallet: { publicKey: dummy.publicKey, payer: dummy }, // read-only; no txs
    env,
    accountSubscription: { type: 'websocket' },
    perpMarketIndexes: [marketIndex],
  });

  try {
    await drift.subscribe();
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes('410') || msg.toLowerCase().includes('disabled')) {
      console.error(
        `FATAL RPC 410/disabled from ${RPC_URL}.\n` +
        `Use a mainnet provider that allows Drift account queries & websockets.\n` +
        `Tip: set RPC_URL and WS_URL to your provider endpoints (e.g., Helius/Triton/QuickNode/Ankr/GenesysGo).`
      );
    }
    throw e;
  }

  console.log(`[${now()}] subscribed to ${env} – ${MARKET_SYMBOL} (index ${marketIndex})`);

  // EMAs
  let fast = null, slow = null;
  let lastLogTs = 0;
  let lastSaveTs = 0;

  const loop = setInterval(() => {
    try {
      const market = drift.getPerpMarketAccount(marketIndex);
      if (!market) return;

      // mid from vAMM bid/ask
      const [bidBN, askBN] = calculateBidAskPrice(
        market.amm,
        drift.getOracleDataForPerpMarket(marketIndex)
      );
      const bid = convertToNumber(bidBN, PRICE_PRECISION);
      const ask = convertToNumber(askBN, PRICE_PRECISION);
      const mark = (bid + ask) / 2;

      fast = ema(fast, mark, FAST_EMA);
      slow = ema(slow, mark, SLOW_EMA);

      if (fast && slow) {
        const delta = fast - slow;
        const threshold = mark * 0.0005; // 5 bps hysteresis

        if (delta > threshold && state.position <= 0) {
          const qty = Math.max(0.001, BASE_NOTIONAL / mark);
          paperFill('buy', qty, mark);
          console.log(`[${now()}] LONG +${qty.toFixed(4)} @ ~${mark.toFixed(4)} | cash=${state.cash.toFixed(2)}`);
        }
        if (delta < -threshold && state.position >= 0) {
          const qty = Math.max(0.001, BASE_NOTIONAL / mark);
          paperFill('sell', qty, mark);
          console.log(`[${now()}] SHORT -${qty.toFixed(4)} @ ~${mark.toFixed(4)} | cash=${state.cash.toFixed(2)}`);
        }
      }

      const t = Date.now();

      // periodic status
      if (t - lastLogTs > LOG_EVERY_MS) {
        lastLogTs = t;
        const mtm = markToMarketPx(mark);
        const equity = state.cash + state.realizedPnL + mtm;
        console.log(
          `[${now()}] mark≈${mark.toFixed(4)} pos=${state.position.toFixed(4)} ` +
          `entry=${state.entryPrice.toFixed(4)} RPNL=${state.realizedPnL.toFixed(2)} ` +
          `fees=${state.feesPaid.toFixed(2)} equity=${equity.toFixed(2)} ` +
          `deposit=${state.deposit.toFixed(2)}`
        );
      }

      // periodic autosave (in addition to per-trade)
      if (t - lastSaveTs > 30000) {
        lastSaveTs = t;
        saveState(state);
      }
    } catch (e) {
      console.error('loop error:', e?.message || e);
    }
  }, 1000);

  const shutdown = async () => {
    clearInterval(loop);
    try { await drift.unsubscribe(); } catch {}
    saveState(state);
    const last = state.trades[state.trades.length - 1];
    console.log('\n=== FINAL PAPER STATS ===');
    console.log(`Trades: ${state.trades.length}`);
    console.log(`Realized PnL: ${state.realizedPnL.toFixed(2)}`);
    console.log(`Fees Paid: ${state.feesPaid.toFixed(2)}`);
    console.log(`Cash: ${state.cash.toFixed(2)} | Position: ${state.position.toFixed(6)} @ ${state.entryPrice.toFixed(6)}`);
    if (last) console.log(`Last trade: ${last.t} ${last.side} ${last.qty} @ ${last.px}`);
    console.log(`State saved to ${statePath}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
