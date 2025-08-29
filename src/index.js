import 'dotenv/config';
import { createConfig } from './config.js';
import { createLogger } from './logging/logger.js';
import { createStore } from './state/store.js';
import { createPaperBroker } from './execution/paperBroker.js';
import { createDriftContext } from './drift/client.js';
import { buildMarketUniverse } from './markets/universe.js';
import { createStrategy as createEMAAdaptive } from './strategies/emaAdaptive.js';
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

  // Strategy instances per market (same config for now)
  const strategiesBySymbol = {};
  for (const { symbol } of universe) {
    strategiesBySymbol[symbol] = createEMAAdaptive({
      fastPeriod: cfg.FAST_EMA,
      slowPeriod: cfg.SLOW_EMA,
      baseNotional: cfg.BASE_NOTIONAL,
      longOnly: false,
      enterBpsLong: 20, exitBpsLong: 10,
      enterBpsShort: 28, exitBpsShort: 12,
      minHoldMs: 2*60*1000, cooldownMs: 30*1000,
      volLookback: 60, volK: 1.5,
      breakoutLookback: 0, breakoutBps: 5
    });
  }

  const broker = createPaperBroker(cfg, store, log);

  await runBot({ cfg, log, store, ctx, universe, strategiesBySymbol, broker });
}

main().catch((e) => {
  console.error('fatal:', e?.stack || e);
  process.exit(1);
});
