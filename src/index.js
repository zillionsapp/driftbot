import 'dotenv/config';
import { createConfig } from './config.js';
import { createLogger } from './logging/logger.js';
import { createStore } from './state/store.js';
import { createPaperBroker } from './execution/paperBroker.js';
import { createDriftContext } from './drift/client.js';
import { buildMarketUniverse } from './markets/universe.js';
import { createStrategy as createEMAAdaptive } from './strategies/emaAdaptive.js';
import { createRiskManager } from './risk/riskManager.js';
import { runBot } from './bot/runBot.js';

async function main() {
  const cfg = createConfig();
  const log = createLogger(cfg);

  const store = await createStore(cfg, log);

  // Resolve market universe and subscribe only to those indexes
  const { list: universe, indexes } = await buildMarketUniverse(cfg);
  log.info(`universe: ${universe.map(x => x.symbol).join(', ')}`);

  const ctx = await createDriftContext(cfg, log, {
    perpMarketIndexes: indexes,
    spotMarketIndexes: [],
  });
  log.info(`subscribed to ${ctx.env} – perp indexes [${indexes.join(', ')}]`);

  // Strategy instances per market (seeded from store)
  const strategiesBySymbol = {};
  for (const { symbol } of universe) {
    const seed = store.getStrategyState(symbol) || {};
    const mkt = store.ensureMarket(symbol);
    // One-time sync if seed has no lastState but we have a position
    if (!seed.lastState && mkt.position) {
      seed.lastState = mkt.position > 0 ? 'long' : 'short';
    }
    const stratCfg = { ...cfg.STRAT_EMA, seed };
    strategiesBySymbol[symbol] = createEMAAdaptive(stratCfg);
  }

  const broker = createPaperBroker(cfg, store, log);
  const risk = createRiskManager(cfg, store, log);

  await runBot({ cfg, log, store, ctx, universe, strategiesBySymbol, broker, risk });
}

main().catch((e) => {
  console.error('fatal:', e?.stack || e);
  process.exit(1);
});
