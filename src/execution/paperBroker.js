import { nowIso } from '../utils/time.js';

/**
 * Paper broker with per-market bookkeeping, global cash.
 */
export function createPaperBroker(cfg, store, log) {
  const state = store.get();
  const feeBps = 2;      // 2 bps per side
  const slippageBps = 1; // 1 bps

  function applyFee(notional, mkt) {
    const fee = (feeBps / 1e4) * Math.abs(notional);
    mkt.feesPaid += fee;
    state.cash -= fee;
  }

  function slip(price, side) {
    const s = (slippageBps / 1e4) * price;
    return side === 'buy' ? price + s : price - s;
  }

  function markToMarketPx(symbol, markPrice) {
    const mkt = store.ensureMarket(symbol);
    if (mkt.position === 0) return 0;
    const pnlPerUnit = (markPrice - mkt.entryPrice) * Math.sign(mkt.position);
    return pnlPerUnit * Math.abs(mkt.position);
  }

  function paperFill(symbol, side, qty, markPrice) {
    if (qty <= 0) return;
    const mkt = store.ensureMarket(symbol);

    const px = slip(markPrice, side);
    const notional = px * qty;

    // cash (global)
    if (side === 'buy') state.cash -= notional;
    else state.cash += notional;

    // fees
    applyFee(notional, mkt);

    // position & realized (per-market)
    const prevPos = mkt.position;
    const newPos = prevPos + (side === 'buy' ? qty : -qty);

    if (prevPos === 0 || Math.sign(prevPos) === Math.sign(newPos)) {
      // increase / same side
      const totalCost = mkt.entryPrice * Math.abs(prevPos) + px * qty;
      const newQtyAbs = Math.abs(newPos);
      mkt.entryPrice = newQtyAbs > 0 ? totalCost / newQtyAbs : 0;
    } else {
      // reduce/close/flip
      const closingQty = Math.min(Math.abs(prevPos), qty);
      const realized = (px - mkt.entryPrice) * Math.sign(prevPos) * closingQty;
      mkt.realizedPnL += realized;

      if (Math.abs(newPos) > 0 && Math.sign(newPos) !== Math.sign(prevPos)) {
        // flipped
        mkt.entryPrice = px;
      } else if (newPos === 0) {
        mkt.entryPrice = 0;
      }
    }

    mkt.position = newPos;

    const trade = {
      t: nowIso(),
      side,
      qty,
      px,
      notional: px * qty * (side === 'sell' ? 1 : -1)
    };
    store.recordTrade(symbol, trade);
    return trade;
  }

  return {
    markToMarketPx,
    paperFill
  };
}
