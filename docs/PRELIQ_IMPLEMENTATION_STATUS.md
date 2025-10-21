# Pre-Liquidation Alpha Implementation Status

## Phase 1: Discovery & Indexing Layer ✅ (SKELETON COMPLETE)

### Files Created:
- `/offchain/indexer/morpho_preliq_indexer.ts` - Pre-liquidation offer discovery
- `/offchain/tools/public_allocator_probe.ts` - Liquidity intelligence
- `/offchain/executor/preliq_executor.ts` - Bundler3 execution layer
- `/offchain/pipeline/preliq_scorer.ts` - Pre-liq specific scoring

### TODO Items for Production:

> **2025-10-18 progress note (alpha wiring)**
> - Added configuration schema + example entries (`preliq` section) and runtime validation helpers.
> - Morpho candidate enrichment now reads factory/init code hash/bundler routing from config, with offer-param caching and better authorization logging.
> - Indexer polling, HF thresholds, and cache TTLs are all sourced from the `preliq.chains` block (per-chain overrides supported).
> - Pre-liq executor consumes chain config, prefers 1inch with Odos fallback per settings, and returns Bundler3 bundle artefacts with in-process submission via Bundler3.
> - Scoring thresholds are now configurable (min incentive, liquidity score, oracle divergence, net USD).

### Current Highlights (2025-10-18)

- Config-driven end-to-end flow: indexer, scorer, and executor hydrate runtime parameters directly from `preliq` config.
- Morpho candidates enrich with CREATE2-computed offers, per-chain cache TTLs, and max-health-factor guardrails.
- Bundler3 bundle builder now emits canonical `multicall(Call[])` payloads with 1inch/Odos swap data embedded in callback calldata.
- PreLiquidation callback contract deployed in repo with Foundry tests ensuring repay/beneficiary flows (ERC20 + WETH unwrap) and Bundler3 submission path now wired through orchestrator.
- Sample config + docs updated; `npm run build` passes with the new wiring.

### Remaining Blockers

1. **On-chain artifacts** – Deploy / confirm PreLiquidation factories, derive init code hash, and populate env/config (factory + bundler endpoints now in tree).
2. **Execution handoff** – Bundler3 submission path now live (callback repay/profit handling implemented); outstanding items: nonce management, relay/Timeboost integration, confirmation loop.

#### 1. Contract Addresses (HIGH PRIORITY)
- [x] Get Morpho PreLiquidation Factory addresses for Base, Arbitrum, Optimism
- [x] Get Bundler3 contract addresses for all chains
- [x] Get Odos Router V2 address
- [x] Get Morpho Blue main contract address per chain

#### 2. Event Monitoring & CREATE2 (HIGH PRIORITY)
- [ ] Implement `PreLiquidationCreated` event listener with proper log parsing
- [x] Implement CREATE2 address computation using `PreLiquidationAddressLib` (in-code CREATE2 helper complete)
- [ ] Add block reorganization handling
- [ ] Add RPC fallback for missed events

#### 3. Offer Parameter Fetching (HIGH PRIORITY)
- [x] Implement `fetchOfferParams()` to read from PreLiquidation offer contract:
  - `marketId`, `preLLTV`, `preLCF1`, `preLCF2`, `preLIF1`, `preLIF2`
  - `oracleAddress`, `expiry`
- [x] Implement `checkAuthorization()` to call `Morpho.isBorrowerAuthorized()`
- [ ] Add caching layer in Redis for offer params (currently using in-memory TTL cache)

- [x] Implement 1inch API integration (primary)
- [x] Implement Odos API integration (`POST /sor/quote/v2`) as fallback
- [x] Build canonical Bundler3 `multicall(Call[])` payload (callbackData packs swap + profit wiring)
- [x] Finalise callback execution flow:
  3. Repay call ✅
  4. Profit extraction call ✅
- [x] Add multicall encoding with proper ABI
- [x] Add multicall encoding with proper ABI
#### 5. Oracle Validation (MEDIUM PRIORITY)
- [ ] Implement pre-liq oracle price fetching
- [ ] Compare pre-liq oracle vs market oracle (detect manipulation)
- [ ] Add staleness checks
- [ ] Alert on divergence > threshold

#### 6. Public Allocator API (MEDIUM PRIORITY)
- [ ] Confirm Morpho Public Allocator API endpoint
- [ ] Implement `fetchLiquidityData()` API call
- [ ] Parse response and build liquidity snapshot
- [ ] Add error handling and retry logic

#### 7. Transaction Execution (HIGH PRIORITY)
- [x] Implement `executePreLiquidation()` transaction builder
- [ ] Add nonce management integration
- [x] Add gas estimation and price oracle
- [ ] For Arbitrum: Implement Timeboost sealed bid submission
- [ ] For Base/Optimism: Use private RPC endpoints
- [ ] Add transaction confirmation monitoring
- [ ] Add profit tracking and logging

#### 8. Metrics & Monitoring (MEDIUM PRIORITY)
- [ ] Add Prometheus metrics:
  - `preliq_offers_discovered_total`
  - `preliq_offers_authorized_total`
  - `preliq_fills_total`
  - `preliq_pnl_usd_total`
  - `preliq_oracle_divergence`
- [ ] Add Grafana dashboards
- [ ] Add alerts for missed offers
- [ ] Add PnL tracking per market

#### 9. Integration with Orchestrator (HIGH PRIORITY)
- [ ] Wire pre-liq indexer into main orchestrator
- [ ] Add protocol adapter for 'morphoblue-preliq'
- [ ] Modify scorer to handle pre-liq candidates
- [x] Add pre-liq execution path to executor
- [ ] Add fallback to standard Morpho liquidation

#### 10. Testing & Validation (HIGH PRIORITY)
- [ ] Unit tests for CREATE2 address computation
- [ ] Unit tests for effective parameter calculation
- [ ] Unit tests for profit estimation
- [ ] Integration tests with Bundler3
- [ ] Fork tests on Base/Arbitrum/Optimism
- [ ] Dry-run mode for pre-liq (no actual execution)

#### 11. Configuration (MEDIUM PRIORITY)
- [x] Add pre-liq specific config section to `config.yaml` and `config.example.yaml`
- [x] Add market/chain-specific pre-liq enablement flags (`preliq.enabled`, `preliq.chains[chainId].enabled`)
- [ ] Optional: document remaining environment overrides (if we decide to keep them for fallbacks)

#### 12. Documentation (LOW PRIORITY)
- [ ] Add runbook for pre-liq monitoring
- [ ] Document CREATE2 computation
- [ ] Document Bundler3 multicall structure
- [ ] Add troubleshooting guide

---

## Estimated Timeline

### Week 1 (Current): Skeleton Implementation ✅
- Created all core files with architecture
- Defined types and interfaces
- Outlined all major functions

### Week 2: Core Implementation (HIGH PRIORITY)
- Get all contract addresses
- Implement event monitoring
- Implement Bundler3 integration
- Implement offer parameter fetching

### Week 3: Integration & Testing
- Wire into orchestrator
- Add protocol adapter
- Fork testing on all chains
- Dry-run validation

### Week 4: Production Deployment
- Deploy to production with dry-run mode
- Monitor for offer discovery
- Gradually enable execution
- Monitor PnL and capture rate

---

## Dependencies

### External APIs:
- Morpho Public Allocator API (liquidity data)
- Odos API (primary swap routing)
- 1inch API (fallback swap routing)

### Smart Contracts:
- PreLiquidationFactory (per chain)
- PreLiquidation Offer contracts (created per borrower)
- Bundler3 (multicall executor)
- Morpho Blue main contract (authorization checks)

### Infrastructure:
- Timeboost client (Arbitrum)
- Private RPC endpoints (Base/Optimism)
- Redis (offer caching)
- Prometheus (metrics)
- Grafana (dashboards)

---

## Risk Mitigation

1. **Oracle Manipulation**: Compare pre-liq oracle vs market oracle
2. **Front-running**: Use Timeboost + private lanes
3. **Insufficient Liquidity**: Check Public Allocator before execution
4. **Reverts**: Comprehensive simulation before sending
5. **Authorization Revoked**: Check authorization immediately before execution
6. **Expired Offers**: Filter by expiry timestamp

---

## Success Metrics

- **Capture Rate**: ≥90% of authorized pre-liq offers
- **Revert Rate**: <2% of executed transactions
- **Inclusion Time**: p95 <100ms
- **Net PnL**: Positive after gas + routing costs
- **Missed Offers**: Zero (detected but not filled by us, later filled by others)

---

## Next Steps

1. **IMMEDIATE**: Get all Morpho contract addresses from team
2. **WEEK 1**: Implement event monitoring and CREATE2 computation
3. **WEEK 1**: Implement Bundler3 multicall construction
4. **WEEK 2**: Implement Odos/1inch API integration
5. **WEEK 2**: Wire into orchestrator
6. **WEEK 3**: Fork testing and dry-run validation
7. **WEEK 4**: Production deployment with monitoring
