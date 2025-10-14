# Long-Tail Arbitrage Fabric – Production Architecture

> Prime directive: maximize net USD/hour with smarter coverage, not raw speed.

## North-Star Objectives

- **Capture ≥ 90%** of observable risk-free edges across target L2s.
- **Sustain p95 inclusion < 120 ms** while keeping revert rate under 1.5%.
- **Maintain gas/PNL ≥ 4×** and net $/hr trending upward over 30-day trailing window.
- **Automate capital rotation** so per-chain float utilization stays between 50–80%.

## System Pillars

### 1. Market Surface + Price Graph
- **Pair Registry** (existing) extended with:
  - Multi-venue metadata (factory, quoter, depth tiers, emissions schedule hints).
  - Pool health scores derived from tick/liquidity staleness, oracle drift, and swap cadence.
- **Price Graph Service** (new):
  - Maintains per-token adjacency with best bid/ask, depth buckets, and implied spreads.
  - Ingests Uniswap v3 slot0 + observations, Curve `get_dy`, Balancer SOR REST, and Velodrome/Beethoven subgraphs.
  - Emits `GraphSnapshot` events consumed by solvers; refresh cadence ≤ 1s with event-driven bumps on Swap/Mint/Burn.

### 2. Quoter Mesh 2.0
- Deterministic on-chain reads (slot0, tick bitmap) plus fallback to Quoter for precise slippage.
- **Depth-aware quoting**: compute blended price for 25%, 50%, 100%, 200% of baseline size.
- **Cost attribution**: per-venue gas estimate, protocol fee, predicted MEV leak, failure probability.
- **Adaptive suppression**: backoff window escalates with consecutive faults, decays on success.

### 3. Solver Stack
- **Single-hop Solver**: consumes depth tiers, dynamic sizing per venue health.
- **Triangular Solver**: enumerates token cycles using price graph, prunes loops with weak liquidity.
- **Cross-chain Coordinator**: pairs cheapest vs richest markets, references inventory state, chooses mode:
  - *Inventory*: execute both legs atomically with existing float.
  - *JIT bridge*: request intent if spread ≥ bridge cost + safety buffer.
  - *Asymmetric flash*: flash on expensive side, route proceeds via private relay to cheaper venue.
- **RFQ Integrator**: optional leg replacement using CowSwap/Intent providers when AMMs are thin.

### 4. Execution Fabric
- **Bundle Builder**: constructs sequenced legs (flash swap → swaps → repay → sweep) with granular deadlines & slippage caps.
- **Private Relay Matrix**: Arbitrum/Optimism/Base/Polygon endpoints with redundancy, fallback to priority gas auction.
- **Failure Classifier**: tags on-chain errors → updates venue penalty scores, adjusts solver thresholds automatically.

### 5. Treasury + Inventory
- **Inventory Manager** (existing) extended with:
  - Rolling utilization metrics & target reserve ratios.
  - Auto top-up based on predicted opportunity density per chain.
- **Bridge Broker**: publishes intents to internal queue + webhook for human/automation review; integrates with Autobahn/LayerZero when JIT bridging approved.
- **Nightly Sweep Task**: consolidates profits to treasury wallet, refresh float limits.

### 6. Risk + Policy Guardrails
- Dynamic `MIN_NET_USD` & `PNL_MULT_MIN` tuned by recent fill quality.
- Revert rate tracker with multi-stage throttle (raise thresholds, shrink max parallel, disable venues).
- Oracle staleness guard: require latest timestamp within target SLA, else degrade venue score.
- Venue denylist + watchlist loaded from config service (Redis-backed for hot reload).

### 7. Observability & Ops
- **Metrics**: Prometheus dashboards for edge generation rate, edge -> submit conversion, slippage realized, inventory utilization, bridge queue.
- **Alerting**: Notify when revert >2% over 1h, edge rate collapses, native RPC latency spikes, or inventory deficit exceeds float.
- **Logging**: Structured JSON with trace IDs linking solver decision → execution → settlement.
- **Replay Harness**: deterministic re-sim leveraging captured PriceGraph snapshots for regression testing.

## Deployment Stages

1. **Phase 0 (Foundations)**
   - Finish depth-aware quoting, PriceGraph snapshots, solver modularization.
   - Baseline Prometheus alerts and Grafana dashboards.

2. **Phase 1 (Canary Single-hop)**
   - Enable on Arbitrum/Optimism with size clamps.
   - Run 72h soak; tune thresholds, validate revert <1.5%.

3. **Phase 2 (Triangular + Base)**
   - Expand to Base + Polygon; raise concurrency after stable metrics.
   - Introduce venue penalty scoring and auto-throttle.

4. **Phase 3 (Cross-chain + RFQ)**
   - Deploy inventory rebalancer, integrate bridge intents.
   - Add RFQ fallback for thin markets.

5. **Phase 4 (Scale & Iterate)**
   - Onboard new DEX adapters, enlarge float, negotiate MEV rebates.
   - Continually optimize pair universe via Alpha miner heuristics.

## Key Open Items

- Implement PriceGraph cache + event listeners.
- Build depth-aware Quoter API and expose to solvers.
- Wire RFQ/intent execution path with trust-minimized settlements.
- Expand automated tests covering opportunity scoring, suppression logic, and treasury drains.

This document is the authoritative map for making LAF the highest-probability alpha engine while staying aligned with the “smarter, not faster” mandate.
