// src/risk/riskManager.js
//
// Lightweight risk layer for paper trading:
// - Daily loss limit (relative to day-start equity)
// - Per-market max position (USD)
// - Global throttle: max trades per minute
// - Cooldown after a realized-loss trade
// - Always allow exits to flat
//
// All knobs come from cfg.RISK. No hardcoded defaults here.

export function createRiskManager(cfg, store, log) {
  const R = cfg.RISK;
  if (!R) throw new Error('cfg.RISK must be defined in config.js');

  const tradeTimestamps = []; // global throttle window (ms)
  let lastLossTs = 0;

  function now() { return Date.now(); }

  function prune(arr, windowMs) {
    const t = now();
    while (arr.length && t - arr[0] > windowMs) arr.shift();
  }

  function calcUPnLTotal() {
    const state = store.get();
    let upnl = 0;
    for (const [symbol, mkt] of Object.entries(state.markets)) {
      if (mkt.lastMark == null || !Number.isFinite(mkt.position)) continue;
      if (mkt.position === 0) continue;
      const pnlPerUnit = (mkt.lastMark - mkt.entryPrice) * Math.sign(mkt.position);
      upnl += pnlPerUnit * Math.abs(mkt.position);
    }
    return upnl;
  }

  function getEquity() {
    const state = store.get();
    return state.cash + calcUPnLTotal();
  }

  function ensureDayStartEquity() {
    const state = store.get();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (!state.meta.dayStartDate || state.meta.dayStartDate !== today) {
      const eq = getEquity();
      state.meta.dayStartDate = today;
      state.meta.dayStartEquity = eq;
      store.save();
      return eq;
    }
    return state.meta.dayStartEquity;
  }

  function isExit(symbol, side) {
    const mkt = store.ensureMarket(symbol);
    if (side === 'buy') return mkt.position < 0;   // buy closes short
    if (side === 'sell') return mkt.position > 0;  // sell closes long
    return false;
  }

  function capByMaxPosition(symbol, side, desiredQty, mark) {
    const mkt = store.ensureMarket(symbol);
    const maxUsd = Number(R.MAX_POSITION_USD_PER_MARKET || 0);
    if (!maxUsd || maxUsd <= 0) return desiredQty;

    // Position after this fill (clamped by runner to avoid flips)
    const nextPos = (side === 'buy') ? (mkt.position + desiredQty) : (mkt.position - desiredQty);
    const nextAbsUsd = Math.abs(nextPos) * mark;
    if (nextAbsUsd <= maxUsd) return desiredQty;

    // Reduce qty so that nextAbsUsd == maxUsd
    const targetAbsBase = maxUsd / mark;
    const maxDeltaBase = Math.max(0, targetAbsBase - Math.abs(mkt.position));
    return Math.min(desiredQty, maxDeltaBase);
  }

  function evaluate(symbol, side, desiredQty, mark) {
    const state = store.get();
    const exit = isExit(symbol, side);

    // Always allow exits to flat (risk constraints shouldn't trap positions)
    if (exit) {
      return { allowed: desiredQty > 0, qty: desiredQty, reason: desiredQty > 0 ? 'exit' : 'zero' };
    }

    // Throttle new entries: max trades per minute (global)
    prune(tradeTimestamps, 60_000);
    if (tradeTimestamps.length >= (R.MAX_TRADES_PER_MIN || 0)) {
      return { allowed: false, qty: 0, reason: 'throttle' };
    }

    // Cooldown after realized loss
    if (R.COOLDOWN_AFTER_LOSS_MS && now() - lastLossTs < R.COOLDOWN_AFTER_LOSS_MS) {
      return { allowed: false, qty: 0, reason: 'cooldown_after_loss' };
    }

    // Daily loss limit (relative to day-start equity)
    if (R.DAILY_LOSS_LIMIT_PCT && R.DAILY_LOSS_LIMIT_PCT > 0) {
      const dayStartEq = ensureDayStartEquity();
      const eq = state.cash + calcUPnLTotal();
      const floorEq = dayStartEq * (1 - R.DAILY_LOSS_LIMIT_PCT / 100);
      if (eq <= floorEq) {
        return { allowed: false, qty: 0, reason: 'daily_loss_limit' };
      }
    }

    // Cap per-market position (USD)
    const cappedQty = capByMaxPosition(symbol, side, desiredQty, mark);
    if (cappedQty < desiredQty) {
      return { allowed: true, qty: cappedQty, reason: 'max_position' };
    }

    // All checks passed
    tradeTimestamps.push(now());
    return { allowed: true, qty: desiredQty, reason: 'ok' };
  }

  function onRealizedPnL(pnl) {
    if (pnl < 0) lastLossTs = now();
  }

  return {
    evaluate,
    onRealizedPnL,
    ensureDayStartEquity,
  };
}
