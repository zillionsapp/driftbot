# Drift Paper Bot — Modular, Multi-Market, Risk-Aware (Node.js)

A scalable **paper trading** bot for **Drift Protocol** (Solana), written in Node 18+ (ESM).  
It cleanly separates **config**, **markets**, **strategy**, **execution**, **risk**, **state**, and **orchestration** so you can extend it fast and operate within RPC constraints.

> ⚠️ **Paper only**. No transactions are sent. The wallet is a dummy `Keypair` used for read-only subscription.



## Highlights

- **Modular architecture**
  - **Markets**: pick one or many via `MARKETS` env; only subscribes to those indexes.
  - **Strategy**: pluggable `emaAdaptive` — **bull & bear**, cost/vol-aware, warmup, state machine, breakout filter.
  - **Risk manager**: daily loss cap, per-market position cap, trade throttling, cooldown after losses.
  - **Execution**: self-contained paper broker with fees, slippage, realized/unrealized PnL.
  - **State**: JSON persistence with per-market books and **strategy seeding** on restart.

- **RPC-friendly**
  - Subscribes **only** to required `perpMarketIndexes`.
  - `skipLoadUsers: true`, **MAX_MARKETS** clamp, optional `ACCOUNT_SUB_TYPE=polling`.
  - Loop **tick** interval + **min move (bps) gate** + optional **jitter** to reduce churn and cost.

- **Correct accounting**
  - **Equity = cash + Σ(UPNL)** (RPNL already flows through cash).
  - NAV cross-check in logs.



## Project Layout

```

drift-paperbot/
package.json
.env.example
README.md
src/
index.js                 # wires everything together
config.js                # single source of truth for knobs (STRAT\_EMA, RISK, etc.)
logging/logger.js        # timestamped logger (info/warn/error/debug?)
utils/ema.js             # EMA helper(s)
utils/time.js            # nowIso()
state/store.js           # JSON-backed state; per-market books; strategy snapshot persistence
execution/paperBroker.js # fees, slippage, realized/unrealized PnL; returns realizedDelta on fills
risk/riskManager.js      # daily loss, position caps, throttling, cooldown; equity helper
markets/resolveMarketIndex.js
markets/universe.js      # parses MARKETS env, resolves to market indexes, clamps MAX\_MARKETS
drift/client.js          # Connection + DriftClient subscribe; getMarkPrice()
strategies/emaAdaptive.js# adaptive EMA; bull/bear; warmup; volatility & breakout aware
bot/runBot.js            # orchestrator; seeds strategy; clamps exits; applies risk; logs; autosave

```

---

## Quick Start

```bash
npm i
cp .env.example .env
# Fill RPC_URL (and WS_URL if your provider requires a separate websocket endpoint)
npm start
````

### Minimal `.env` example

```ini
# --- Required ---
RPC_URL=YOUR_MAINNET_ENDPOINT
WS_URL=YOUR_WS_ENDPOINT          # optional but recommended

# --- Network/Markets ---
NETWORK=mainnet-beta
MARKETS=SOL-PERP                 # or SOL-PERP,BTC-PERP (keep short on lower RPC tiers)
MAX_MARKETS=1                    # clamp to avoid 413s on small plans

# --- Strategy (emaAdaptive) ---
BASE_NOTIONAL=100
FAST_EMA=20
SLOW_EMA=60
LONG_ONLY=false
ENTER_BPS_LONG=20
EXIT_BPS_LONG=10
ENTER_BPS_SHORT=28
EXIT_BPS_SHORT=12
MIN_HOLD_MS=120000
COOLDOWN_MS=30000
VOL_LOOKBACK=60
VOL_K=1.5
BREAKOUT_LOOKBACK=0
BREAKOUT_BPS=5
MIN_WARM_TICKS=120               # if omitted => max(2 * SLOW_EMA, 200)

# --- Bot cadence & noise gating ---
TICK_MS=5000
MIN_MARK_MOVE_BPS=2
TICK_JITTER_MS=500

# --- State ---
STATE_FILE=./state.json
RESET_STATE=false
INITIAL_DEPOSIT=10000

# --- Subscription mode ---
ACCOUNT_SUB_TYPE=websocket       # or polling

# --- Risk ---
MAX_POSITION_USD_PER_MARKET=0    # 0 = unlimited
MAX_TRADES_PER_MIN=20
DAILY_LOSS_LIMIT_PCT=0           # e.g., 3 = halt new entries after -3% day
COOLDOWN_AFTER_LOSS_MS=60000
```

---

## How It Works (in one pass)

1. **Config**: `createConfig()` centralizes *all* knobs, builds `STRAT_EMA` & `RISK`.
2. **Universe**: `buildMarketUniverse()` parses `MARKETS`, resolves each to a **marketIndex**, clamps to `MAX_MARKETS`.
3. **Client**: `createDriftContext()` subscribes only to those indexes; `getMarkPrice(index)` returns `{bid, ask, mark}`.
4. **State**: `store` holds global cash/deposit and **per-market**: position, entry, RPNL, fees, `lastMark`, `strategy` snapshot.
5. **Strategy**: for each market we `createEMAAdaptive(cfg.STRAT_EMA)` and **seed it** from `store.getStrategyState(symbol)`.
6. **Risk**: `risk.evaluate()` vets entries (always allows exits) and caps quantity.
7. **Broker**: `paperFill()` applies slip & fees, updates cash & PnL; returns `realizedDelta` for cooldown logic.
8. **Runner**: `runBot()` loops by `TICK_MS` (+ optional jitter), gates tiny moves by `MIN_MARK_MOVE_BPS`, calls strategy, clamps exits to flat (no one-tick flips), applies `risk`, fills via broker, persists strategy `snapshot()`, autosaves.
9. **Logs**: periodic status prints **px**, **pos**, **entry**, **UPNL/RPNL/fees**, and **equity=cash+UPNL** with a NAV sanity check.

---

## Strategy — `emaAdaptive`

* **Bull & Bear**: decides regime from **slow EMA slope**; long when bullish, short when bearish (`LONG_ONLY=false` to enable shorts).
* **Cost aware**: uses **bps thresholds**, widened by **EWMA volatility** (`VOL_K`).
* **Churn guards**: `MIN_HOLD_MS`, `COOLDOWN_MS`.
* **Warmup**: no signals until `MIN_WARM_TICKS` (default derived from `SLOW_EMA` if not provided).
* **Optional breakout**: `BREAKOUT_LOOKBACK/BREAKOUT_BPS` to confirm near highs/lows before entering.

> Strategy instance is **stateful** and **seeded** from `store` to be restart-safe (EMAs, lastState, volEwmaBps, etc.).

---

## Risk — `riskManager`

* **Daily loss limit**: halts **new entries** if equity drops beyond `DAILY_LOSS_LIMIT_PCT` vs **day-start equity** (tracked in `state.meta`).
* **Per-market position cap**: `MAX_POSITION_USD_PER_MARKET`.
* **Throttle**: global `MAX_TRADES_PER_MIN`.
* **Cooldown after loss**: pauses entries for `COOLDOWN_AFTER_LOSS_MS` after a trade realizing a loss.
* **Always allow exits** to flat (risk never traps positions).

---

## Execution — `paperBroker`

* **Fees/Slippage**: 2 bps fee + 1 bp slip (per side) — configurable in code if you want.
* **PnL math**: realized on partial closes and flips; VWAP entry maintained.
* **Returns** `{ trade, realizedDelta }` so risk can trigger cooldowns on losing fills.

---

## Logging & Accounting

* Per-market status:
  `px≈…, pos=…, entry=…, UPNL=…, RPNL=…, fees=…`
* Equity line:
  `equity = cash + Σ(UPNL)` (RPNL already in cash).
* NAV cross-check:
  `alt = deposit + RPNL + UPNL – feesTotal` (warn if mismatch).

---

## RPC Notes (read this if you hit 413s)

Lower-tier endpoints (e.g., QuickNode **Discover**) may reject large `getMultipleAccounts` calls:

* **Subscribe minimally**: only the indexes in your universe.
* **Clamp**: `MAX_MARKETS=1` (raise cautiously).
* **`skipLoadUsers: true`**: we don’t read user maps in paper mode.
* **`ACCOUNT_SUB_TYPE=polling`**: fallback if WS costs or limits are painful.
* **Cadence**: increase `TICK_MS`, use `MIN_MARK_MOVE_BPS`, optionally `TICK_JITTER_MS`.

---

## Extend

* **More strategies**: drop a new file in `src/strategies/` that exports `createStrategy(cfg) -> { onPrice, snapshot? }`. Instantiate per market in `index.js`.
* **Per-market overrides**: add `STRAT_EMA_BY_SYMBOL` to `config.js` and merge with the base `STRAT_EMA` before creating each strategy.
* **Backtesting (TODO)**: add a `feeds/` CSV reader and a `scripts/backtest-ema.js` to reuse the same strategy + broker offline.
* **Funding bias (nice-to-have)**: plumb funding rates into the strategy context and require positive funding for shorts, etc.

---

## Scripts

You can add scripts like:

```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "NODE_ENV=development node src/index.js",
    "lint": "eslint .",
    "prettier": "prettier -w ."
  }
}
```

*(If you add a markets lister or backtester later, wire them here.)*

---

## Environment Variables (reference)

**Core**

* `RPC_URL` *(required)*, `WS_URL` *(optional)*, `NETWORK` (default `mainnet-beta`)

**Markets**

* `MARKETS` (comma-sep symbols like `SOL-PERP,BTC-PERP`)
* `MAX_MARKETS` (safety clamp)

**Strategy (emaAdaptive)**

* `BASE_NOTIONAL`, `FAST_EMA`, `SLOW_EMA`, `LONG_ONLY`
* `ENTER_BPS_LONG`, `EXIT_BPS_LONG`, `ENTER_BPS_SHORT`, `EXIT_BPS_SHORT`
* `MIN_HOLD_MS`, `COOLDOWN_MS`
* `VOL_LOOKBACK`, `VOL_K`
* `BREAKOUT_LOOKBACK`, `BREAKOUT_BPS`
* `MIN_WARM_TICKS`

**Runner & Noise Gating**

* `TICK_MS`, `MIN_MARK_MOVE_BPS`, `TICK_JITTER_MS`

**State**

* `STATE_FILE`, `RESET_STATE`, `INITIAL_DEPOSIT`

**Subscription**

* `ACCOUNT_SUB_TYPE=websocket|polling`

**Risk**

* `MAX_POSITION_USD_PER_MARKET`
* `MAX_TRADES_PER_MIN`
* `DAILY_LOSS_LIMIT_PCT`
* `COOLDOWN_AFTER_LOSS_MS`

---

## Guarantees & Non-Goals

* ✔️ No live orders; no keys required for trading.
* ✔️ Deterministic, restart-safe indicators via persisted snapshots.
* ❌ No real PnL; fees/slippage are modelled.
* ❌ Not a profit promise; use backtests before risking capital.

---

## Troubleshooting

* **Equity seems off** → confirm it’s `cash + UPNL` only; RPNL already flows through `cash`.
* **Churn/fees high** → raise `ENTER_BPS_*`, lengthen EMAs, increase `MIN_HOLD_MS`, or enable breakout filter.
* **RPC errors 410/413** → reduce `MAX_MARKETS`; try `polling`; increase `TICK_MS`; verify WS endpoint; consider a Solana-focused RPC.

---

## License

MIT. Use at your own risk.

