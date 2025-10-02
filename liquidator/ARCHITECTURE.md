# L2 Micro-Liquidator Architecture

This document captures how the bot is structured end-to-end so new contributors can understand the moving pieces and how they interact.

---

## High-Level Flow

1. **Configuration Load**
   - `config.yaml` (generated via `npm run sync:aave`) contains each chain’s contracts, token metadata, policy guardrails, routing hints, and risk caps.
   - `offchain/infra/env.ts` loads `.env`, exposing RPC URLs, private keys, database credentials, etc.
   - `offchain/infra/config.ts` parses YAML + env overrides into a typed `AppConfig` consumed everywhere else.

2. **Indexing / Candidate Discovery**
   - `offchain/indexer/aave_indexer.ts` pulls Aave reserves from both The Graph (batch) and realtime watchers (`offchain/realtime/watchers.ts`).
   - `offchain/indexer/price_watcher.ts` caches Chainlink prices, invalidating them on feed updates.
   - The indexer streams `Candidate` objects (borrower, debt, collateral, health factor) per chain to the orchestrator.

3. **Policy Filtering & Simulation**
   - `offchain/orchestrator.ts` receives candidates and runs a gauntlet:
     - Kill switch / deny list / throttle checks
     - Asset policy lookups using `offchain/util/symbols.ts` to match symbols/addresses
     - Sequencer freshness guard (`offchain/infra/sequencer.ts`)
     - Route construction (`offchain/util/routes.ts`) and price gap comparison versus Chainlink
   - `offchain/simulator/simulate.ts` estimates liquidation profitability:
     - Calculates repay/seize amounts
     - Queries router quotes (`offchain/simulator/router.ts`) with slippage guardrails
     - Estimates gas + L1 data costs (L2-specific logic in `simulate.ts`)
     - Returns a `Plan` with `netUsd`, `pnlPerGas`, selected route, and calldata payload.

4. **Execution**
   - If the plan clears `risk` guardrails (`pnlPerGasMin`, `gasCapUsd`, session notional caps), orchestration hands it to `offchain/executor/send_tx.ts`.
   - `send_tx.ts` uses Viem wallet clients (`offchain/executor/mev_protect.ts`) to submit via public or private RPCs, handling nonce discipline and health-factor revert detection.
   - On success, attempts are recorded (`offchain/infra/attempts.ts`), metrics/counters update, and inventory caches refresh.

5. **Contracts**
   - `contracts/Liquidator.sol` is the on-chain executor:
     - Supports Aave V3 flash loans and “inventory mode” (contract-held funds)
     - Swaps collateral via `contracts/libs/DexRouter.sol` supporting UniV3, UniV2, Solidly
     - Only owner/executor addresses can call, router allowlist and minProfit enforced
   - ABI lives in `offchain/executor/Liquidator.abi.json`.

6. **Telemetry & Ops**
   - `offchain/infra/logger.ts` (Pino) writes JSON logs to stdout and `logs/live.log` via `logs/log_insights.js`
   - `offchain/infra/metrics.ts` exposes Prometheus metrics (`simulate_duration_seconds`, `pnl_per_gas`, etc.) served by `offchain/infra/metrics_server.ts` on port 9464.
   - `docker-compose.yml` includes Postgres, Redis, Prometheus, Grafana, Loki for local desk operations.
   - `offchain/tools/*` provides operational scripts:
     - `sync_config.ts` (token/policy generator)
     - `preflight.ts`, `feed-check.ts`, `quote-check.ts`, `replay-candidates.ts`, `allow_routers.ts` and more.

7. **Risk & Safeguards**
   - Guardrails in `config.yaml`:
     - `assets` policy per token (min net BPS, gap cap, slippage)
     - `risk` caps (max repay USD, session notional, pnl/gas minimum, denylist)
   - Automatic health-factor checks before/after execution; kill switch file halts all agents.
   - `offchain/infra/attempts.ts` persists attempt history for auditing/analytics.

---

## Code Layout Overview

```
contracts/                Solidity contracts + libraries
  Liquidator.sol
  libs/DexRouter.sol

offchain/
  orchestrator.ts         Main entrypoint per process
  executor/               Build + send transactions (Viem wallet integration)
  indexer/                Aave candidate + price feed ingestion
  simulator/              Profit/loss + routing simulation
  realtime/               Websocket/HTTP pollers for pool + Chainlink events
  infra/                  Shared services: config, env, logging, metrics, DB, Redis, sequencer
  util/                   Symbol/policy helpers, routing serialization, deep merge
  tools/                  Ops scripts (sync_config, preflight, feed-check, etc.)
  agent/                  Backtesting endpoints, API helpers

ops/                      Dockerfile, env samples, docker-compose
monitoring/               Prometheus/Grafana/Loki configuration
scripts/                  Shell wrappers for development
```

## Operational Workflow

1. Update `.env` with RPC/WS URLs, private keys, DB creds.
2. Generate config with `npm run sync:aave`.
3. Build/compile (`npm run build`, `forge build/test`).
4. Deploy `Liquidator.sol` per chain; update `config.yaml.contracts.liquidator`.
5. `npm run dev` to start orchestrator (use `risk.dryRun: true` for canary).
6. Monitor metrics at `http://<host>:9464/metrics`, dashboards via `docker-compose` stack.
7. Production: run orchestrator under process manager with `risk.dryRun: false`, watch logs/alerts.

---

For deeper dives, see module-level docs:
- `offchain/simulator/simulate.ts` for full gas/L1 cost model
- `contracts/Liquidator.sol` for protocol specifics
- `offchain/tools/*` for maintenance scripts

