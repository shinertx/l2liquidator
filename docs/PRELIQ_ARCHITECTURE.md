# Liquidation Platform Architecture

## Mission

Run the fastest, most reliable liquidation platform on L2s by combining:

- Deterministic discovery of Morpho Blue pre-liquidations and standard liquidations across Morpho and Aave v3.
- Inventory-free execution using Morpho callbacks, Bundler3 multicalls, and L2-optimized DEX aggregation.
- Smart ordering policies (Timeboost on Arbitrum, private-lane latency on OP-stack) to stay first in line.
- Unified observability so every opportunity is tracked from discovery through realized PnL.

The system must never miss an authorized offer, must close profitable liquidations without external capital, and must fall back to existing flash-loan paths whenever pre-liqs are unavailable.

---

## End-to-End Flow

```
                 +-----------------------------+
                 |  On-chain Protocol Events   |
                 |  (Aave v3, Morpho Blue)     |
                 +----+-------------------+----+
                      |                   |
      Aave/Morpho subgraphs & SDKs        |   Pre-Liq Factory logs & CREATE2
                      |                   |
                      v                   v
          +-----------+-------+   +-------+------------+
          | Standard Indexers |   | Pre-Liq Indexer    |
          | (Aave & Morpho)   |   | (offers & params)  |
          +-----------+-------+   +-------+------------+
                      \               /        |  Public Allocator API
                       \             /         v
                        \           /   +--------------+
                         v         v    | Offer Cache  |
                     +-----------------+--------------+
                     | Position & Market State Store  |
                     +-----------------+--------------+
                                       |
                                       v
                          +--------------------------+
                          | Scoring & Policy Engine  |
                          +-----------+--------------+
                                      |
                           +----------+-----------+
                           |                      |
                 +---------v--------+   +---------v--------+
                 | Pre-Liq Executor |   | Standard Executor |
                 | (Bundler3 Path)  |   | (Flash-Loan Path) |
                 +---------+--------+   +---------+--------+
                           |                      |
                           v                      v
                     Settlement & Profit Accounting
```

---

## Subsystems

### 1. Discovery & State

| Component | Responsibilities | Key Inputs | Outputs |
|-----------|------------------|------------|---------|
| `offchain/indexer/morphoblue_indexer.ts` | Stream Morpho positions, market configs, health factors for standard liquidations. | Morpho subgraph, RPC clients | Position snapshots, market metadata |
| `offchain/indexer/aave_indexer.ts` | Track Aave v3 positions, price feeds, risk params. | Aave subgraphs, Chainlink, RPC | Candidates for standard Aave liquidations |
| `offchain/indexer/morpho_preliq_indexer.ts` | Detect pre-liq offers deterministically: factory logs + CREATE2 address derivation; enforce borrower authorization; pull pre-liq parameters & oracle source; maintain offer lifecycle. | Morpho Pre-Liquidation contracts, Morpho SDK/API | Offer records with incentives, oracle feeds, expiry |
| `offchain/tools/public_allocator_probe.ts` | Periodically query Morpho Public Allocator to grade market liquidity depth & incentive strength. | Public Allocator API | Liquidity scores attached to offers & markets |
| Config Sync (`npm run sync:aave`, `sync:morpho`, `sync:morpho:markets`, `sync:morpho:quick`) | Ensure `config.yaml` includes all referenced tokens, policies, markets. | On-chain metadata, logs | Up-to-date config for runtime |

All state is persisted in Redis/Postgres (existing infra) with keys for borrower, market, and offer address so the scorer always has a consistent snapshot.

### 2. Scoring & Policy Engine

Implemented in `offchain/pipeline/scorer.ts` with two protocol families:

- **Pre-Liq path (`morphoblue-preliq`)**
  - Inputs: offer params (`preLLTV`, linear `preLCF{1,2}`, `preLIF{1,2}`), authorization status, borrower debt/collateral balances, pre-liq oracle price stream, routing quotes (1inch primary, Odos fallback), gas estimates, market liquidity scores.
  - Logic: compute effective close factor & incentive at current health factor, enforce invariants (`preLIF2 ≤ 1/LLTV`, monotonic ramps), evaluate profit after routing, gas, and expected ordering cost (Timeboost bid). Reject if any policy fails or if pre-liq oracle diverges too far from market oracle.

- **Standard path (`aavev3`, `morphoblue`)**
  - Reuse existing scoring flow for close factor = 1, using Chainlink/Morpho oracles, router quotes, gas budgets, borrower retry guards.

Both flows share global policies: borrower attempt throttles, deny lists, minimum profit thresholds, and risk engine overrides.

### 3. Execution Layer

| Module | Description |
|--------|-------------|
| `offchain/executor/preliq_executor.ts` | Implements `IPreLiquidationCallback.onPreLiquidate`. Builds Bundler3 multicall that: (1) seizes collateral via pre-liq callback, (2) swaps collateral→debt (1inch primary, Odos fallback) using pre-generated calldata, (3) repays debt within the same bundle, (4) routes residual profit to beneficiary. No external flash loan needed. Handles revert safeguards & fallback switching if aggregator fails. |
| `offchain/executor/morpho_executor.ts` | Existing flash-loan path for standard Morpho liquidations with Morpho’s built-in flash loans. Used when no authorized pre-liq exists or when the pre-liq execution fails pre-checks. |
| `offchain/executor/aave_executor.ts` | Existing Aave v3 flash-loan based executor. |
| Ordering module (`offchain/executor/send_tx.ts`, new Timeboost client) | Handles sequencing strategy: <br>• Arbitrum – compute bid curve for Timeboost, ensure profit net of bid remains positive, integrate with nonce & priority fee manager. <br>• Base / Optimism – route through private RPC endpoints, tune priority fees for low latency, no mempool sniping. |
| Router configuration (`config.yaml:routing`, `dexRouters`) | Maintains allowed routers and fee tiers; reused for 1inch/Odos aggregator limits within pre-liq bundles. |

### 4. Monitoring & Telemetry

| Asset | Additions |
|-------|-----------|
| Metrics (`offchain/infra/metrics.ts`) | New Prometheus counters/gauges: `preliq_offers_discovered_total`, `preliq_offers_authorized_total`, `preliq_offers_scored_total{status}`, `preliq_fills_total`, `preliq_profit_usd_total`, `preliq_slippage_bps`, `preliq_oracle_divergence{market}`, `preliq_timeboost_bids_total`. Existing standard liquidation metrics remain. |
| Logging (Pino) | Structured events for `preliq-offer`, `preliq-authorization`, `preliq-score`, `preliq-exec`, `timeboost-bid`, `allocator-snapshot`. Each record captures borrower, market, oracle source, incentive, routing decision, and outcome. |
| Dashboards | Grafana dashboards aggregating metrics per chain/protocol/oracle type, plus internal reconciliation runbooks; alert rules on missed offers, divergence spikes, execution revert rate, and aggregator failures. |

### 5. Deployment & Operations

- The worker container continues to run the orchestrator, indexers, scorer, and executors. Pre-liq additions are part of the same process space.
- `docker-compose` exposes Bundler3 dependencies (if any additional environment variables or read-only mounts required).
- `scripts/deploy_preliq_check.sh` performs a deployment sanity pass: ensures config synced, callbacks compiled, aggregator endpoints reachable, Timeboost credentials loaded.
- Preflight (`offchain/tools/preflight.ts`) extends to verify: Morpho callbacks accessible, Bundler3 contracts reachable, 1inch responding (Odos optional), Timeboost API credentials present, pre-liq oracle feeds healthy.
- Runbooks (in `DEPLOYMENT_CHECKLIST.md` & `doc/PRELIQ_IMPLEMENTATION_STATUS.md`) cover sync commands, gas/ordering tuning, monitoring dashboards, and incident response.

---

## Key Guarantees

1. **Comprehensive Discovery** – Every authorized pre-liq offer is captured via dual sources (logs + CREATE2), recorded with full incentive parameters, and monitored until filled or expired.
2. **Profit-First Scoring** – Candidates are only executed when expected PnL after routing, gas, and ordering costs remains positive, with safeguards against oracle drift and stale data.
3. **Atomic Execution** – Pre-liq fills do not require external liquidity; Bundler3 multicalls guarantee seize→swap→repay completes or reverts as a unit.
4. **Robust Fallbacks** – Standard Morpho and Aave execution paths remain intact, ensuring revenue continuity when pre-liq flow is light or aggregator routes fail.
5. **Ordering Edge** – Chain-specific sequencing strategies keep the platform ahead of competitors (Timeboost on Arbitrum, private lanes on OP chains).
6. **Observable Outcomes** – Every stage (offer discovery, scoring decision, execution result) is logged and available in metrics so capture rate and profitability can be audited in real time.

The architecture keeps the existing liquidation engine intact while layering a fully integrated pre-liquidation capability that is deterministic, capital-efficient, and observability-driven. This ensures we maintain leadership on Base and across other L2s as pre-liq volume grows.
