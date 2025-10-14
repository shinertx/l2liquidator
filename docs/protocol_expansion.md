# Protocol Expansion Roadmap

Our goal is to add five new venues to the liquidation engine: **Aave v3 (Ethereum mainnet)**, **Compound v3 (Base & Optimism)**, **Morpho Blue**, **Radiant**, and **Silo**. Below is a phased plan that breaks down the work required to bring each protocol into production.

## Phase 0 – Shared Prerequisites
- [ ] Confirm gas budgets and funding sources for L1 execution (higher fees on mainnet).
- [ ] Extend config tooling (`sync_config`) to support protocol-specific schemas (per-market liquidation thresholds, risk params).
- [ ] Verify router allow-list scripts handle multi-protocol deployments (different contracts per protocol & chain).
- [ ] Ensure monitoring dashboards and alerting can tag metrics per protocol/chain.
- [ ] Draft QA checklist for each new protocol (dry-run mode, fork tests, real execution rehearsal).

## Phase 1 – Aave v3 (Ethereum Mainnet)
**Why first?** Highest liquidity and minimal engineering divergence from our existing L2 Aave adapters.

Work items:
- [ ] Indexer: point existing aave indexer to mainnet subgraph/RPC, add chain config.
- [x] Config: add mainnet chain entry (RPCs, tokens, markets, risk overrides). Adjust min profit / gas caps for L1 costs. _(Scaffolding committed; markets remain disabled until testing completes.)_
- [ ] Router coverage: whitelist mainnet routers (UniV3, Curve, Balancer, 1inch aggregation if needed). Update allow script with mainnet Safe.
- [ ] Simulator: reuse Aave adapter; confirm swap routing handles deep liquidity pools.
- [ ] Execution: wire Safe address, beneficiary, private tx lanes if any.
- [ ] Monitoring: per-chain dashboards, gas/PnL KPI.
- [ ] QA: fork-test high-notional liquidations; simulate worst-case gas; dry-run mainnet staging.

## Phase 2 – Compound v3 (Base & Optimism)
**Focus:** USDC-centric markets; more frequent liquidations due to isolated collateral buckets.

Work items:
- [ ] Indexer: implement Compound v3 risk assessment (per-market collateral/debt). Potentially rely on on-chain event scanning since subgraph coverage is limited.
- [x] Config: add `compoundv3` protocol block per chain, deposit/borrow token metadata. _(Markets scaffolded and disabled until adapter is ready.)_
- [ ] Simulator: create Compound v3 execution adapter (call `absorb()` or collateral seize flow). Support flash-repay via 1inch if needed.
- [ ] Routing: ensure base/optimism routers cover USDC <> collateral conversions (Aerodrome, Velodrome, Uniswap, Curve).
- [ ] Execution & policy: configure close factors, min profit thresholds specific to comp v3 incentives.
- [ ] QA: fork-tests absorbing accounts, cross-check with public liquidation bots.

## Phase 3 – Morpho Blue
**Focus:** Peer-to-peer pools with unique collateral/borrow pairings—requires precise accounting per vault.

- **Work items:**
  - [ ] Indexer: integrate Morpho Blue API/graph for at-risk vaults. Need per-market risk config (oracle price, LTV, liquidation bonus).
  - [ ] Simulator: implement Morpho Blue liquidation transaction flow (interaction with aggregator + pool). Handle dual calls if needed.
  - [x] Config: add placeholder market definitions/tokens (disabled) for initial Morpho Blue vaults.
  - [ ] Routing: ensure collateral swap path exists (may need Balancer/Curve for LSD tokens).
  - [ ] Policy: set min collateral size, whitelist “safe” vault IDs.
  - [ ] Execution: deploy/configure liquidator, router allow-list, Safe wiring.
  - [ ] QA: run canary mode on small vaults, monitor for protocol-specific edge cases.

## Phase 4 – Radiant (Arbitrum)
**Focus:** Aave fork with cross-chain features; similar math but new addresses & incentives.

- **Work items:**
  - [x] Indexer: Radiant subgraph/API integration, or adapt aave indexer with new schema.
  - [x] Config: scaffold Radiant markets/tokens on Arbitrum (disabled until adapter is implemented).
  - [x] Simulator: reuse Aave flash loan logic if compatible, else implement Radiant-specific liquidation contract call.
  - [ ] Routing: include Camelot, Balancer, GMX pools as swap venues.
  - [ ] Execution: configure Radiant liquidator contract (deploy if necessary) and router allow-list.
  - [ ] QA: fork-test Radiant liquidations; ensure bridging of profit if required.

## Phase 5 – Silo
**Focus:** Isolated asset pairs across multiple chains; each silo has unique collateral-debt relationship.

- **Work items:**
  - [ ] Indexer: integrate Silo’s APIs or direct contract reads (health factor per silo pair).
  - [ ] Config: capture each silo’s asset pair, correct price feeds, borrow caps.
  - [ ] Simulator: implement Silo liquidation flow (flash repay + seize + swap) tailored per silo structure.
  - [ ] Routing: ensure liquidity exists for niche tokens (may require aggregators or OTC intermediate routes).
  - [ ] Execution: per-chain contract deployments, router allow-list per silo.
  - [ ] QA: test on Silo’s recommended markets first, then expand gradually.

## Operational To-Do per Protocol
For each integration, track these standard tasks:
1. **Define markets & risk params** (config entries, thresholds, min profit).
2. **Indexer implementation** (data source + filtering + throttling).
3. **Simulator/Execution adapter** (transaction encoding, swap routing, gas estimation).
4. **Routing allow-list** (router addresses, Safe approvals, inventory handling).
5. **Monitoring & alerting** (chain/protocol metrics, Prometheus dashboards, alert thresholds).
6. **Testing** (unit/fork tests, dry-run, canary deployment strategy).
7. **Operational runbook** (deployment steps, rollback plan, per-protocol known issues).

## Next Steps
- Decide prioritization order (recommend Phase 1 → Phase 2 first for impact vs. effort). 
- Assign owners for each workstream (indexing, simulation, infra, QA).
- Schedule scoping sessions per protocol to refine data sources and contract call patterns.
- Stand up staging configs for Aave mainnet to begin testnet/fork validation.
- **User TODO:** populate `.env` with real mainnet RPC/WS URLs, private lanes, Safe + liquidator addresses, then deploy/allow routers before enabling the new markets.
- **User TODO:** add Compound v3 data sources (subgraph/API endpoints, on-chain RPCs) to `.env` for Base/Optimism ahead of adapter implementation.

Project tracking should live in the team’s Notion/Jira, with this doc as the overview. Update status per protocol as work completes.
