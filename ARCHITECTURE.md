# Architecture Overview

This document captures how the codebase is structured end-to-end so new contributors can understand the moving pieces and how they interact. It now contains **two** execution surfaces that share infrastructure but run independently:

1. **L2 Micro-Liquidator** – the original Aave v3 liquidation engine (Arbitrum / Optimism / Base / Polygon).
2. **Long-Tail Arbitrage Fabric (LAF)** – an optional arbitrage module that reuses the same watcher → scorer → executor pipeline but discovers swaps instead of liquidations. **TODO:** Restore the full fabric configuration (single-hop, triangular, cross-chain) and validate venue readiness.

Both systems live in this repository, share Redis/Postgres/Prometheus, and can run side-by-side without stepping on each other.

---

## L2 Micro-Liquidator

### High-Level Flow

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

6. **Telemetry & Ops** **TODO:** Extend dashboards/alerts to cover Coinbase-backed Morpho markets and LAF.
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

* **Adapters** isolate protocol quirks. Morpho Blue, Silo, and (later) Ajna each implement discovery, candidate streaming, parameter reads, and bundle construction. **TODO:** Extend adapters for Base Morpho + Coinbase listings.
* **Watchers** subscribe to adapter feeds (`Borrow`, `Repay`, `Liquidate`, `NewSilo`, etc.) and poll health states. A dual-price watcher (`DEPEG_MODE`) can be toggled to compare oracle vs spot. **TODO:** Verify feed coverage for new assets (USR, USD0, Pendle PTs).
* **Scorer** evaluates each candidate with venue-aware bonus math, per-chain gas curves, router pre-quotes, revert statistics, and optional depeg adjustments. Hard guards enforce `net >= MIN_NET_USD`, `gas/net <= 1/PNL_MULT_MIN`, `revert <= MAX_REVERT_RATE`, and depth constraints. **TODO:** Tune pre-liquidation sizing ($300–$3k) and require pnl/gas ≥ 4×.
* **Exec Workers** operate under per-market semaphores, assembling a single private bundle: optional flash borrow → protocol liquidation → exit swap → flash repayment → profit sweep. **TODO:** Wire RFQ/intent exits for BTC/cbBTC routes.
* **Exit Router** evaluates AMM, RFQ, and Intent paths, picking the cheapest route that satisfies min-out and embedding it in the same bundle to avoid backruns. **TODO:** Validate revert tracking and slippage guards under new venues.
* **Treasury** manages chain-local USDC buckets, auto top-ups, and scheduled sweeps. Spend caps enforce per-chain daily exposure limits. **TODO:** Raise BTC repay caps ($10–30k) and update sweep policy.
* **Telemetry & SLO Gates** monitor inclusion p95, revert rates, pnl/gas, and net USD/hour. Breaches trigger concurrency reduction and, after repeated strikes, auto-pauses for the offending market or chain. **TODO:** Add alerts for Coinbase-backed vault changes and Morpho/Base anomalies.

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

---

## Long-Tail Arbitrage Fabric (LAF)

LAF is a parallel opportunity generator/executor that feeds the same Prometheus, logging, and treasury surfaces as the micro-liquidator while staying isolated in `offchain/arb_fabric/*`. It is **optional**: if you do not run `npm run fabric`, none of these modules are activated.

### Components

| Stage | Purpose | Key Files |
| --- | --- | --- |
| **Pair Registry** | Loads DEX pools (currently UniV3) per chain, normalises trade sizes and venues | `offchain/arb_fabric/pair_registry.ts`, `fabric.config.yaml` |
| **Quoter Mesh** | Runs deterministic on-chain quotes for each leg/fee tier | `offchain/arb_fabric/quoter_mesh.ts` |
| **Solvers** | Emit `QuoteEdge` objects: single-hop, triangular, and cross-chain (stub) | `single_hop_solver.ts`, `triangular_solver.ts`, `cross_chain_solver.ts` |
| **Risk Manager** | Edge freshness, net thresholds, back-off based on recent failures | `risk.ts`, `throttle.ts` |
| **Inventory Manager** | Tracks chain floats, raises bridge intents when balances dip | `inventory_manager.ts`, `bridge_broker.ts` |
| **Executor** | Collapses legs into one UniV3 `exactInput` bundle, handles approvals and metrics | `executor.ts` |
| **Replay/Analysis** | JSONL replay tool for census logs | `offchain/tools/laf_replay.ts` |

### Execution Model

- `npm run fabric` boots the LAF runner (in census mode by default) which:
  1. Loads `fabric.config.yaml` (path configurable via `FABRIC_CONFIG`).
  2. Streams edges from enabled solvers.
  3. Applies risk/throttle checks.
  4. In census mode: logs opportunities and steps metrics only.
  5. In active mode: executes bundles and records attempts in `laf_attempts`.
- Metrics are exported on a dedicated port (`FABRIC_PROM_PORT`, default 9470). Prometheus scrapes them under the `laf-orchestrator` job with `project=laf`.
- Bridge intents are written to `logs/fabric_bridge_intents.jsonl` and optionally forwarded to `FABRIC_BRIDGE_WEBHOOK`.

### Interaction with the Micro-Liquidator

- Shared infra: Redis, Postgres, Prometheus/Grafana, logging directory.
- Separate processes and metrics ports, so crashes or restarts do not impact the liquidator runner.
- Shared attempt-store schema (`liquidation_attempts`, `laf_attempts`) for auditing and backtesting.
- `QuoteEdge` types live under `offchain/pipeline/types.ts`; the micro-liquidator pipeline ignores them unless you intentionally insert edges into that flow.

### Operational Checklist

1. **Census** – run `npm run fabric` with `global.mode=census` to verify edge density and PnL.
2. **Funding** – populate the per-chain floats specified in `fabric.config.yaml`.
3. **Automation** – wire bridge intents to treasury bots via `FABRIC_BRIDGE_WEBHOOK` or monitor the JSONL log manually.
4. **Active Mode** – flip to `global.mode=active`, restart the runner, and monitor `laf_exec_success_total`, `laf_edge_net_usd`, and `laf_attempts` output.
5. **Expansion** – add venues/pairs/chains as coverage grows; reuse solver toggles and throttle settings in config.

LAF-specific TODOs and future upgrades live under `offchain/arb_fabric`, while the core micro-liquidator TODOs remain with their respective protocol adapters and execution stubs.

Refer to `docs/avalanche_hunter.md` for venue-specific checklists and to the rollout playbook above for sequencing the migration.

---

For deeper dives, see module-level docs:
- `offchain/simulator/simulate.ts` for full gas/L1 cost model
- `contracts/Liquidator.sol` for protocol specifics
- `offchain/tools/*` for maintenance scripts
