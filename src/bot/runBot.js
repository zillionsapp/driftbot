import { nowIso } from '../utils/time.js';

/**
 * Run orchestrator across a market universe.
 * Each market has its own strategy instance and state entry.
 */
export async function runBot({ cfg, log, store, ctx, universe, strategiesBySymbol, broker, risk }) {
  let lastLogTs = 0;
  let lastSaveTs = 0;
  const state = store.get();

  const fmtPx = (v) => v == null ? 'n/a' : (v >= 1000 ? v.toFixed(2) : v.toFixed(4));

  const tick = async () => {
    try {
      for (const { symbol, marketIndex } of universe) {
        const px = await ctx.getMarkPrice(marketIndex);
        if (!px) continue;

        const mkt = store.ensureMarket(symbol);
        const prevMark = mkt.lastMark;
        mkt.lastMark = px.mark;

        // price move gate
        if (prevMark != null) {
          const moveBps = Math.abs((px.mark - prevMark) / prevMark) * 1e4;
          if (moveBps < cfg.MIN_MARK_MOVE_BPS) continue;
        }

        const strat = strategiesBySymbol[symbol];
        const signal = strat.onPrice(px);

        // persist strategy snapshot (restart-safe)
        if (strat.snapshot) {
          store.setStrategyState(symbol, strat.snapshot());
        }

        // --- Execution with clamp + risk ---
        const baseQty = Math.max(0.001, signal.baseNotional / px.mark);

        if (signal.action === 'buy') {
          let qty = 0;
          if (mkt.position < 0) {
            // exit short toward flat (no flip)
            qty = Math.min(baseQty, Math.abs(mkt.position));
          } else if (mkt.position === 0) {
            // enter long from flat
            qty = baseQty;
          }
          if (qty > 0) {
            const evalRes = risk.evaluate(symbol, 'buy', qty, px.mark);
            if (evalRes.allowed && evalRes.qty > 0) {
              const { trade, realizedDelta } = broker.paperFill(symbol, 'buy', evalRes.qty, px.mark);
              risk.onTrade({ symbol, side: 'buy', qty: evalRes.qty, price: px.mark, realizedDelta });
              log.info(`${nowIso()} [${symbol}] BUY ${evalRes.qty.toFixed(4)} @ ~${px.mark.toFixed(4)} | cash=${state.cash.toFixed(2)} (${evalRes.reason})`);
            } else {
              log.debug?.(`[${symbol}] BUY vetoed: ${evalRes.reason}`);
            }
          }
        }

        if (signal.action === 'sell') {
          let qty = 0;
          if (mkt.position > 0) {
            // exit long toward flat (no flip)
            qty = Math.min(baseQty, mkt.position);
          } else if (mkt.position === 0 && !cfg.STRAT_EMA.longOnly) {
            // enter short from flat
            qty = baseQty;
          }
          if (qty > 0) {
            const evalRes = risk.evaluate(symbol, 'sell', qty, px.mark);
            if (evalRes.allowed && evalRes.qty > 0) {
              const { trade, realizedDelta } = broker.paperFill(symbol, 'sell', evalRes.qty, px.mark);
              risk.onTrade({ symbol, side: 'sell', qty: evalRes.qty, price: px.mark, realizedDelta });
              log.info(`${nowIso()} [${symbol}] SELL ${evalRes.qty.toFixed(4)} @ ~${px.mark.toFixed(4)} | cash=${state.cash.toFixed(2)} (${evalRes.reason})`);
            } else {
              log.debug?.(`[${symbol}] SELL vetoed: ${evalRes.reason}`);
            }
          }
        }
      }

      // periodic status
      const tnow = Date.now();
      if (tnow - lastLogTs > cfg.LOG_EVERY_MS) {
        lastLogTs = tnow;
        const lines = [];
        let upnlTotal = 0;
        let rpnlTotal = 0;

        for (const { symbol } of universe) {
          const mkt = store.ensureMarket(symbol);
          const mtm = mkt.lastMark != null ? broker.markToMarketPx(symbol, mkt.lastMark) : 0;
          upnlTotal += mtm;
          rpnlTotal += mkt.realizedPnL;
          lines.push(
            `[${symbol}] px≈${fmtPx(mkt.lastMark)} ` +
            `pos=${mkt.position.toFixed(4)} entry=${fmtPx(mkt.entryPrice)} ` +
            `UPNL=${mtm.toFixed(2)} RPNL=${mkt.realizedPnL.toFixed(2)} ` +
            `fees=${mkt.feesPaid.toFixed(2)}`
          );
        }

        const equity = state.cash + upnlTotal; // correct equity calc
        log.info(
          `equity=${equity.toFixed(2)} cash=${state.cash.toFixed(2)} ` +
          `UPNL=${upnlTotal.toFixed(2)} RPNL=${rpnlTotal.toFixed(2)} ` +
          `deposit=${state.deposit.toFixed(2)} | ` + lines.join(' | ')
        );

        const feesTotal = Object.values(state.markets).reduce((s,m)=>s + m.feesPaid, 0);
        const navAlt = state.deposit + rpnlTotal + upnlTotal - feesTotal;
        if (Math.abs(navAlt - equity) > 1e-6) {
          log.warn(`NAV mismatch: equity=${equity.toFixed(2)} alt=${navAlt.toFixed(2)}`);
        }
      }

      // periodic autosave
      if (tnow - lastSaveTs > 30000) {
        lastSaveTs = tnow;
        store.save();
      }
    } catch (e) {
      log.error(`loop error: ${e?.message || e}`);
    }

    const jitter = cfg.TICK_JITTER_MS ? Math.floor(Math.random() * cfg.TICK_JITTER_MS) : 0;
    setTimeout(tick, cfg.TICK_MS + jitter);
  };

  // kick off
  risk.ensureDayStartEquity();
  tick();

  const shutdown = async () => {
    try { await ctx.close(); } catch {}
    store.save();

    console.log('\n=== FINAL PAPER STATS ===');
    for (const { symbol } of universe) {
      const m = store.ensureMarket(symbol);
      console.log(`-- ${symbol} --`);
      console.log(`Trades: ${m.trades.length}`);
      console.log(`Realized PnL: ${m.realizedPnL.toFixed(2)}`);
      console.log(`Fees Paid: ${m.feesPaid.toFixed(2)}`);
      console.log(`Position: ${m.position.toFixed(6)} @ ${m.entryPrice.toFixed(6)}`);
      const last = m.trades[m.trades.length - 1];
      if (last) console.log(`Last trade: ${last.t} ${last.side} ${last.qty} @ ${last.px}`);
    }
    console.log(`Cash: ${state.cash.toFixed(2)}`);
    console.log(`State saved to ${cfg.STATE_FILE}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
