import { nowIso } from '../utils/time.js';

export function createPaperBroker(cfg, store, log) {
  const state = store.get();
  const feeBps = 2;      // 2 bps per side
  const slippageBps = 1; // 1 bps

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

  function paperFill(side, qty, markPrice) {
    if (qty <= 0) return;
    const px = slip(markPrice, side);
    const notional = px * qty;

    // cash
    if (side === 'buy') state.cash -= notional;
    else state.cash += notional;

    // fees
    applyFee(notional);

    // position & realized
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

    // event
    const trade = {
      t: nowIso(),
      side,
      qty,
      px,
      notional: px * qty * (side === 'sell' ? 1 : -1)
    };
    store.recordTrade(trade);
    return trade;
  }

  return {
    markToMarketPx,
    paperFill
  };
}
