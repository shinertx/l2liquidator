# Long-Tail Arbitrage Fabric (LAF)

## Purpose
- Expand the existing liquidation stack into a coverage-first arbitrage engine targeting persistent mispricings across L2/sidechain DEX venues.
- Reuse ~80% of the current watcher → scorer → executor pipeline while adding pricing data, solvers, and flash liquidity tooling.
- Prioritise validated, risk-adjusted micro-PnL over latency races; “smarter, not faster.”

## Black-Box Alignment
- Treat LAF as a modular profit engine with a single mandate: raise net USD/hour while honouring the Prime Directive guardrails (capture ≥90% viable flow, revert <2%, inclusion p95 <100 ms).
- External contract: accept normalized `QuoteEdge`s, return signed bundles or census logs; hide venue-specific complexity inside the module.
- Operate behind clear SLOs: ingest latency ≤ 3 sec for top pools, solver debounce < 1 sec, quoter freshness < 2 blocks, treasury drift auto-corrected within 1 hour.
- Report the four critical numbers every epoch (net USD/hour, revert %, inclusion p95, opportunity capture) so other teams can reason about improvements without peering into internals.

## Strategic Goals
- **Coverage density**: monitor hundreds of pools per chain, across multiple DEXes, with depth-aware quotes.
- **Capital efficiency**: favour flash-swaps/flash-loans; maintain minimal per-chain floats only when necessary.
- **Predictable returns**: require gas/PNL ≥ 4× and net ≥ configured USD floor; size conservatively to avoid moving markets.
- **Scalable process**: phased rollout with “census” logging before capital deployment; guardrails for revert rate and inclusion latency.

## System Integration
- **Pair Registry & Quoter Mesh**: new services alongside current indexers; emit `QuoteEdge` opportunities into the same pipeline as liquidation `Candidate`s.
- **Solver Modules**: implement `Solver.findSingleHopEdges`, `findTriangularEdges`, and `findCrossChainEdges` generators producing `QuoteEdge`s with risk metadata.
- **Scorer Extensions**: reuse existing scoring infrastructure; add cost-model inputs for slippage, bridge fees, fail_cost.
- **Executor Enhancements**: extend bundle builder to support flash-swaps, flash-loans, and multi-leg routes while keeping private relay flow unchanged.
- **Telemetry**: leverage existing logging/metrics; add dashboards for edge density, revert %, inclusion latency, per-chain net.

## Components Checklist
- **Registry**
  - Track pools for Uniswap v3, Curve, Balancer/Beethoven, Velodrome, and other L2 AMMs.
  - Cache fee tiers, tick/liquidity snapshots, top-of-book depth.
  - Subscribe to Swap/Mint/Burn (or equivalent) events for freshness.
- **Quoter Mesh**
  - Deterministic on-chain quoting for configured trade sizes.
  - Per-leg gas estimates; batched updates every 3–5 sec (rollups).
  - Persist slippage curves per pair for sizing decisions.
- **Solvers**
  - Single-hop: DEX vs DEX spreads; debounce to reduce churn.
  - Triangular: cycle detection with ratio guard and depth validation.
  - Cross-chain: coordinate simultaneous legs if inventory exists; otherwise gate on spread ≥ bridge_cost + safety.
- **Risk Rails**
  - `MIN_NET_USD`, `PNL_MULT_MIN`, `REVERT_MAX`, venue denylist, stale-quote guard.
  - Adaptive thresholds: raise floors when revert or inclusion p95 worsens.
- **Inventory & Treasury**
  - Lightweight floats per chain (start $1–2k).
  - Automated sweep/top-up rules; spend caps and size clamps.

## Rollout Playbook (14 Days)
1. **Days 1–2**: Enable “no-send census” on Arbitrum/Base/Optimism; WETH/USDC only. Validate edge counts, net after costs, edge lifetime.
2. **Days 3–5**: Add top 100 pairs/chain; turn on single-hop execution with $0.75–$1.00 `MIN_NET_USD`, size ≤ $150, flash-swap bundles, private relay only.
3. **Days 6–7**: Activate triangular solver on top tokens; maintain revert ≤ 2%.
4. **Days 8–10**: Integrate RFQ/intent fallback and flash-loan paths; expand DEX coverage (Velodrome/Beethoven/Ramses/Camelot).
5. **Days 11–14**: Bring up cross-chain inventory loops (ARB↔OP, ARB↔BASE); only execute when spread covers bridge cost + cushion. Begin nightly USDC sweeps and automated report cards.

## Validation & KPIs
- **Census gate**: ≥1,000 net-positive edges/day (net ≥ $1) across tracked chains; median edge life ≥ 5 blocks; quote drift false-positive rate < 10%.
- **Execution gate**: revert ≤ 2%, p95 bundle inclusion < 150 ms, gas/PNL ≥ 4×, rolling 3-day net USD trending upward.
- **Health monitoring**: mismatch between modeled vs realised PnL, solver error rate, bridge fill latency, private relay acceptance.

## Configuration Deltas
```
ARB_ENABLE_ARB_FABRIC=true
OP_ENABLE_ARB_FABRIC=true
BASE_ENABLE_ARB_FABRIC=true
MIN_NET_USD=1.00
PNL_MULT_MIN=4.0
REVERT_MAX=0.02
ALLOW_TRIANGULAR=true
ALLOW_CROSSCHAIN=true
PER_CHAIN_FLOAT_USD=2000
BRIDGE_STRATEGY=intent,fastrouter
DENYLIST_TOKENS=...   # fill with venue-specific token blocks
```

## Operating Best Practices
- Run census mode after any major config/DEX additions before re-enabling sends.
- Keep quoter latency low by colocating RPC endpoints per chain; monitor stale quote alerts.
- Size trades using depth-aware curves; favour multiple small fills over single large hits.
- Maintain private relay relationships and rotate endpoints to avoid inclusion drift.
- Schedule weekly post-mortems on reverts and slippage outliers; feed insights back into solver thresholds.
- Treat cross-chain legs as optional upside; never depend on synchronous bridging when spread barely clears fees.
- Monitor bridge intents emitted as `fabric-bridge-request` logs; action them via treasury automation or disable affected pairs if floats run dry.
- Bridge automation: each intent is written to `logs/fabric_bridge_intents.jsonl` and optionally POSTed to `FABRIC_BRIDGE_WEBHOOK`; plug your treasury bot into this feed to rebalance floats automatically.

## Naming & References
- **Strategy**: “Long-Tail Arbitrage Fabric” or “LAF.”
- **Edge object**: `QuoteEdge`; legs represented as `Leg[]`.
- **Mode flags**: “census” (log-only), “active” (execution), “inventory” (cross-chain with floats).
- **Rollout shorthand**: “Phase 1 (Census) → Phase 2 (Single-hop) → Phase 3 (Triangular) → Phase 4 (Cross-chain).”

## Running the Fabric
- `fabric.config.yaml` drives the black-box module (override path via `FABRIC_CONFIG`).
- Launch with `npm run fabric`; census mode emits `laf-edge-census` logs and bumps `laf_edges_total`.
- Active mode (inventory-backed) reuses the Uniswap v3 router paths to fire WETH→USDC→WETH loops; successful sends increment `laf_exec_success_total`, failures `laf_exec_failed_total`.
- Pre-fund the executor wallet on each chain with the configured `tradeSize.baseAmount` (plus slippage buffer) in the base token, since the current path trades inventory rather than flash liquidity.
- Toggle execution behaviour via `global.mode` (`census`, `active`, `inventory` placeholder). Adjust `slippageBps`, `deadlineBufferSec`, and `maxConcurrentExecutions` under `global` for production tuning.
- Control solver fan-out with `maxVenuesPerLeg` to sample multiple pools per leg when hunting for loops.
- Ensure RPC env vars (`RPC_ARB`, `RPC_OP`, `RPC_BASE`), private endpoints, and per-chain wallet keys are present before moving beyond census.
- Feature toggles: set `enableSingleHop`, `enableTriangular`, and `enableCrossChain` in `fabric.config.yaml` to control solver activation. Triangular loops execute via the shared bundle builder; cross-chain remains census-only until bridge routing is productionised.
- Offline validation: use `npm run laf:replay -- --file logs/laf.jsonl` to replay census output, compute per-source net, and flag pairs worth enabling.
- Atomic execution is driven by the new bundle builder inside `FabricExecutor`, which collapses single-hop and triangular legs into a single Uniswap v3 `exactInput` call; keep all legs on the same chain and supply `feeBps` metadata so the path encoder can assemble the route.

Keep this document updated as modules ship so “LAF” remains a single source of truth for configuration, rollout status, and lessons learned.
