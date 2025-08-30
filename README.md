# Drift Paper Bot (Modular)

A scalable, extensible Node.js paper-trading bot for **Drift Protocol** on Solana.  
It cleanly separates **config**, **state**, **market data**, **execution**, and **strategy** so you can plug in new logic quickly.

## Quick Start

1. **Install**:
   ```bash
   npm i
   cp .env.example .env
   # Fill in RPC_URL (and WS_URL if your provider uses a separate websockets endpoint)
   ```

2. **Run**:
   ```bash
   node src/index.js
   ```

3. **File Tree**
```
drift-paperbot/
  package.json
  .env.example
  README.md
  src/
    index.js
    config.js
    logging/logger.js
    utils/ema.js
    utils/time.js
    state/store.js
    execution/paperBroker.js
    markets/resolveMarketIndex.js
    drift/client.js
    strategies/emaCrossover.js
    bot/runBot.js
```

## Notes (Critical but Solution‑Oriented)

- **Custom WebSocket URL**: Use `new Connection(RPC_URL, { wsEndpoint: WS_URL, commitment: 'confirmed' })`. Passing a 3rd arg to `Connection` is ignored—this fixes it.
- **Pluggable strategies**: Add more files under `src/strategies/` exporting `createStrategy(config)`. The bot calls `strategy.onPrice(tick)` and executes signals.
- **Persistence**: JSON-backed state is abstracted—swap in a DB by re-implementing `store.js`.
- **Risk/Fees/Slippage**: Encapsulated in `paperBroker.js`. Tune `feeBps` / `slippageBps` or implement per-market parameters.

## Environment

- Node 18+
- ESM modules (`type: module`)
- `@drift-labs/sdk` v2+

## Extend

- Add risk rules (max position, daily loss limits) in `paperBroker.js` or a new `risk/` module.
- Add **backtesting** by wiring a historical data feeder that calls `runBot` with a mock `getMarkPrice`.
- Add alerting/metrics via a logger sink (Datadog/Prometheus).
