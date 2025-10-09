# L2 Micro-Liquidator Architecture

This document captures how the bot is structured end-to-end so new contributors can understand the moving pieces and how they interact.

---

## High-Level Flow

### 1. Configuration Load

- `config.yaml` (generated via `npm run sync:aave`) contains each chain’s contracts, token metadata, policy guardrails, routing hints, and risk caps.
- `offchain/infra/env.ts` loads `.env`, exposing RPC URLs, private keys, database credentials, etc.
- `offchain/infra/config.ts` parses YAML + env overrides into a typed `AppConfig` consumed everywhere else. The config now carries a `protocol:` key per market so non-Aave venues can slot in without touching the core loop.

### 2. Protocol Adapters

- `offchain/protocols/types.ts` defines the adapter interface: `streamCandidates`, `pollCandidatesOnce`, `simulate`, and the protocol-specific `PlanRejectedError`.
- `offchain/protocols/registry.ts` resolves adapters by `protocol` key. Today we ship:
  - **`aavev3Adapter`** – fully wired with indexer/simulator/executor.
  - **`siloAdapter`, `ionicAdapter`, `exactlyAdapter`** – lightweight scaffolds that currently emit no candidates and throw a descriptive error if invoked. They are placeholders so new venues can be brought online without refactoring the orchestrator again.
- The orchestrator asks the default adapter for the streaming feed (Aave today) but, during simulation/execution, it resolves the adapter based on `candidate.protocol`. That keeps the multi-venue plumbing isolated to a single switch point. Stubs for Silo/Ionic/Exactly adapters are wired but return empty streams until their full logic ships.

### 3. Indexing / Candidate Discovery

- `offchain/indexer/aave_indexer.ts` pulls Aave reserves from both The Graph (batch) and realtime watchers (`offchain/realtime/watchers.ts`).
- `offchain/indexer/price_watcher.ts` caches Chainlink prices, invalidating them on feed updates.
- The indexer streams `Candidate` objects (borrower, debt, collateral, health factor, protocol) per chain to the orchestrator.
- Stub indexers for Silo/Ionic/Exactly already exist under `offchain/indexer/*_indexer.ts`; they return empty iterators until real WS/HTTP feeds are implemented.

### 4. Policy Filtering & Simulation

- `offchain/orchestrator.ts` receives candidates and runs a gauntlet:
  - Kill switch / deny list / throttle checks
  - Asset policy lookups using `offchain/util/symbols.ts`
  - Sequencer freshness guard (`offchain/infra/sequencer.ts`)
  - Route construction (`offchain/util/routes.ts`) and price gap comparison versus Chainlink
  - Adaptive thresholds via `offchain/infra/adaptive_thresholds_provider.ts`, which can call the optional risk-engine server when `RISK_ENGINE_URL` is set
- `offchain/simulator/simulate.ts` estimates liquidation profitability:
  - Calculates repay/seize amounts
  - Queries router quotes (`offchain/simulator/router.ts`) with slippage guardrails
  - Estimates gas + L1 data costs (L2-specific logic in `simulate.ts`)
  - Returns a `Plan` with `netUsd`, `pnlPerGas`, selected route, and calldata payload.
- For non-Aave venues the simulator hook will funnel through protocol adapters once their venue-specific math is implemented. The scaffolds currently throw a clear “not implemented” error so we know if accidental execution happens.

### 5. Execution

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
  - `offchain/risk_engine/server.ts` (booted via `npm run risk-engine`) stores adaptive threshold snapshots, ingests analytics feedback, and emits updated guardrails.
  - `offchain/analytics/perf_loop.ts` (booted via `npm run analytics:perf`) streams attempt history from Postgres, publishes Prometheus gauges, and POSTs feedback to the risk engine when `RISK_ENGINE_URL` is configured.
   - `docker-compose.yml` includes Postgres, Redis, Prometheus, Grafana, Loki for local desk operations.
   - `offchain/tools/*` provides operational scripts:
     - `sync_config.ts` (token/policy generator)
     - `preflight.ts`, `feed-check.ts`, `quote-check.ts`, `replay-candidates.ts`, `allow_routers.ts` and more.

7. **Risk & Safeguards**
   - Guardrails in `config.yaml`:
     - `assets` policy per token (min net BPS, gap cap, slippage)
     - `risk` caps (max repay USD, session notional, pnl/gas minimum, denylist)
     - Per-market `enabled` flags and protocol keys so experimental venues stay dark until explicitly switched on
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

## Avalanche Hunter – Sealed Runner v2

Avalanche Hunter v2 is the next evolution of the long-tail liquidation program. It keeps today’s micro-liquidator core but seals the pipeline behind protocol adapters, private execution, and SLO-driven guardrails. The goal is a black-box runner that can extend to Morpho, Silo, Ajna, and future venues with minimal surface area changes.

### 1. End-to-End Topology

```
[Adapters] -> [Watchers] -> [Queue] -> [Scorer] -> [Exec Workers] -> [Private Relays]
                                          |                 |
                                          |                 └-> [Exit Router: AMM / RFQ / Intent]
                                          └-> [OpStore / Postgres] -> [Treasury Sweeps]
```

* **Adapters** isolate protocol quirks. Morpho Blue, Silo, and (later) Ajna each implement discovery, candidate streaming, parameter reads, and bundle construction.
* **Watchers** subscribe to adapter feeds (`Borrow`, `Repay`, `Liquidate`, `NewSilo`, etc.) and poll health states. A dual-price watcher (`DEPEG_MODE`) can be toggled to compare oracle vs spot.
* **Scorer** evaluates each candidate with venue-aware bonus math, per-chain gas curves, router pre-quotes, revert statistics, and optional depeg adjustments. Hard guards enforce `net >= MIN_NET_USD`, `gas/net <= 1/PNL_MULT_MIN`, `revert <= MAX_REVERT_RATE`, and depth constraints.
* **Exec Workers** operate under per-market semaphores, assembling a single private bundle: optional flash borrow → protocol liquidation → exit swap → flash repayment → profit sweep.
* **Exit Router** evaluates AMM, RFQ, and Intent paths, picking the cheapest route that satisfies min-out and embedding it in the same bundle to avoid backruns.
* **Treasury** manages chain-local USDC buckets, auto top-ups, and scheduled sweeps. Spend caps enforce per-chain daily exposure limits.
* **Telemetry & SLO Gates** monitor inclusion p95, revert rates, pnl/gas, and net USD/hour. Breaches trigger concurrency reduction and, after repeated strikes, auto-pauses for the offending market or chain.

### 2. Data Plane & Observability

- **OpStore** (Postgres/SQLite) tracks `markets`, `candidates`, `attempts`, `fills`, and `rollups` for analytics, feedback loops, and audits.
- **Prometheus/Grafana/Loki** already ship in `docker-compose`; additional panels should surface SLO gauges, exit router hit-rates, and treasury balances.
- **Risk Engine** ingests attempt history to tune adaptive thresholds; it now also records SLO breach events and prescribed remediation actions.

### 3. Hardening & Supply Chain

- Reproducible Docker images signed with `cosign`; the runner verifies signatures before boot.
- Keys move behind an HSM or remote signer; spend caps and kill-switch hashes are verified on start.
- Public mempool submission is disabled at the process level—only private relays listed in `PRIVATE_RELAYS` are allowed.
- Failure taxonomy automation:
  - `INCLUDED_LOST` → raise tips, drop concurrency for the chain.
  - `ORACLE_STALE` → pause market until fresh round.
  - `DEPTH_INSUFF` → shrink market size caps for 60 minutes.
  - `RELAY_DROP` → rotate to next relay once, then surface an alert.
  - `FLASH_NO_LIQ` → fall back to inventory repay or reduce size.

### 4. Configuration Deltas

New environment knobs (see `.env` template):

```
PNL_MULT_MIN=4.0
MIN_NET_USD=1.50
MAX_REVERT_RATE=0.02
TARGET_P95_MS=100
PRIVATE_RELAYS=flashbots,infura
PUBLIC_MEMPOOL_DISABLED=true

CHAIN_SPEND_CAP_USD=5000
GAS_TOPUP_MIN_USD=1500

MORPHO_ENABLE=true
MORPHO_USE_FLASH=true
MORPHO_PRE_LIQ_SUPPORT=true
SILO_ENABLE=true
SILO_FLASH_PATH=true
AJNA_ENABLE=false

ROUTER_AMM=true
ROUTER_RFQ=true
ROUTER_INTENT=true
ROUTER_SLIP_BP_MAX=60

DEPEG_MODE=false
VOL_MODE_SIZE_SHRINK_BP=500
VOL_MODE_MIN_NET_USD=3.00
```

### 5. Rollout Playbook

1. **Canary:** Enable Silo Arbitrum watcher/executor with `SILO_ENABLE=true`, `SILO_FLASH_PATH=true`, one worker, and `dryRun` until metrics stabilize.
2. **Send Live:** Flip to live after 2h clean dry run; monitor SLO gauges. Scale to four workers when `revert < 2%` and `p95 < 100 ms` for 24h.
3. **Morpho:** After 48h clean stats, enable Morpho with flash repay. Add pre-liquidation path once five successful fills land.
4. **Exit Router Expansion:** Turn on RFQ + Intent once AMM baseline is stable; configure TTL and min quote depth.
5. **Chaos Testing:** Replay 30–90 day forks with randomized gas/oracle lag. Property-test scorer to guarantee `net > 0` decisions.
6. **Operations:** Nightly USDC sweeps, automatic gas top-ups, daily report logging capture rate, net USD/hour, revert rate, inclusion p95.

### 6. Relationship to Avalanche Hunter v1

Avalanche Hunter v1 focused on wiring adapters and config scaffolding for long-tail venues. V2 keeps that groundwork but:

- Upgrades every stage (watchers, scorer, executor, router, treasury) for sealed operation.
- Introduces SLO-aware auto-pauses and a codified failure response matrix.
- Standardizes protocol onboarding via adapters so future venues drop in without core rewrites.
- Treats the runner as a signed black box—suitable for managed deployments where only configs rotate.

Refer to `docs/avalanche_hunter.md` for venue-specific checklists and to the rollout playbook above for sequencing the migration.

---

For deeper dives, see module-level docs:
- `offchain/simulator/simulate.ts` for full gas/L1 cost model
- `contracts/Liquidator.sol` for protocol specifics
- `offchain/tools/*` for maintenance scripts
