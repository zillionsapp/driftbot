import { nowIso } from '../utils/time.js';

export async function runBot({ cfg, log, store, ctx, marketIndex, strategy, broker }) {
  let lastLogTs = 0;
  let lastSaveTs = 0;
  const state = store.get();

  const timer = setInterval(async () => {
    try {
      const px = await ctx.getMarkPrice(marketIndex);
      if (!px) return;

      // Strategy signal
      const signal = strategy.onPrice(px);

      // Execution
      if (signal.action === 'buy' && state.position <= 0) {
        const qty = Math.max(0.001, signal.baseNotional / px.mark);
        const t = broker.paperFill('buy', qty, px.mark);
        log.info(`${nowIso()} LONG +${qty.toFixed(4)} @ ~${px.mark.toFixed(4)} | cash=${state.cash.toFixed(2)}`);
      }
      if (signal.action === 'sell' && state.position >= 0) {
        const qty = Math.max(0.001, signal.baseNotional / px.mark);
        const t = broker.paperFill('sell', qty, px.mark);
        log.info(`${nowIso()} SHORT -${qty.toFixed(4)} @ ~${px.mark.toFixed(4)} | cash=${state.cash.toFixed(2)}`);
      }

      // periodic status
      const tnow = Date.now();
      if (tnow - lastLogTs > cfg.LOG_EVERY_MS) {
        lastLogTs = tnow;
        const mtm = broker.markToMarketPx(px.mark);
        const equity = state.cash + state.realizedPnL + mtm;
        log.info(
          `mark≈${px.mark.toFixed(4)} pos=${state.position.toFixed(4)} ` +
          `entry=${state.entryPrice.toFixed(4)} RPNL=${state.realizedPnL.toFixed(2)} ` +
          `fees=${state.feesPaid.toFixed(2)} equity=${equity.toFixed(2)} ` +
          `deposit=${state.deposit.toFixed(2)}`
        );
      }

      // periodic autosave
      if (tnow - lastSaveTs > 30000) {
        lastSaveTs = tnow;
        store.save();
      }
    } catch (e) {
      log.error(`loop error: ${e?.message || e}`);
    }
  }, cfg.TICK_MS);

  const shutdown = async () => {
    clearInterval(timer);
    try { await ctx.close(); } catch {}
    store.save();
    const last = state.trades[state.trades.length - 1];
    console.log('\n=== FINAL PAPER STATS ===');
    console.log(`Trades: ${state.trades.length}`);
    console.log(`Realized PnL: ${state.realizedPnL.toFixed(2)}`);
    console.log(`Fees Paid: ${state.feesPaid.toFixed(2)}`);
    console.log(`Cash: ${state.cash.toFixed(2)} | Position: ${state.position.toFixed(6)} @ ${state.entryPrice.toFixed(6)}`);
    if (last) console.log(`Last trade: ${last.t} ${last.side} ${last.qty} @ ${last.px}`);
    console.log(`State saved to ${cfg.STATE_FILE}`);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
