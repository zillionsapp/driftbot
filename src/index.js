import 'dotenv/config';
import { createConfig } from './config.js';
import { createLogger } from './logging/logger.js';
import { createStore } from './state/store.js';
import { createPaperBroker } from './execution/paperBroker.js';
import { createDriftContext } from './drift/client.js';
import { resolveMarketIndex } from './markets/resolveMarketIndex.js';
import { createStrategy as createEmaCrossover } from './strategies/emaCrossover.js';
import { runBot } from './bot/runBot.js';

async function main() {
  const cfg = createConfig();
  const log = createLogger(cfg);
  log.info(`starting drift paper bot on ${cfg.MARKET_SYMBOL}`);

  // State (semi-DB)
  const store = await createStore(cfg, log);

  // Drift context (connection + client + market subscription)
  const ctx = await createDriftContext(cfg, log);
  const marketIndex = await resolveMarketIndex(ctx.env, cfg.MARKET_SYMBOL, ctx.PerpMarkets);
  log.info(`subscribed to ${ctx.env} – ${cfg.MARKET_SYMBOL} (index ${marketIndex})`);

  // Strategy (pluggable)
  const strategy = createEmaCrossover({ 
    fastPeriod: cfg.FAST_EMA, 
    slowPeriod: cfg.SLOW_EMA, 
    baseNotional: cfg.BASE_NOTIONAL 
  });

  // Execution (paper)
  const broker = createPaperBroker(cfg, store, log);

  // Run orchestrator
  await runBot({ cfg, log, store, ctx, marketIndex, strategy, broker });
}

main().catch((e) => {
  console.error('fatal:', e?.stack || e);
  process.exit(1);
});
