# Pre-Liquidation Alpha Implementation Status

## Phase 1: Discovery & Indexing Layer ✅ (SKELETON COMPLETE)

### Files Created:
- `/offchain/indexer/morpho_preliq_indexer.ts` - Pre-liquidation offer discovery
- `/offchain/tools/public_allocator_probe.ts` - Liquidity intelligence
- `/offchain/executor/preliq_executor.ts` - Bundler3 execution layer
- `/offchain/pipeline/preliq_scorer.ts` - Pre-liq specific scoring

### TODO Items for Production:

#### 1. Contract Addresses (HIGH PRIORITY)
- [ ] Get Morpho PreLiquidation Factory addresses for Base, Arbitrum, Optimism
- [ ] Get Bundler3 contract addresses for all chains
- [ ] Get Odos Router V2 address
- [ ] Get Morpho Blue main contract address per chain

#### 2. Event Monitoring & CREATE2 (HIGH PRIORITY)
- [ ] Implement `PreLiquidationCreated` event listener with proper log parsing
- [ ] Implement CREATE2 address computation using `PreLiquidationAddressLib`
- [ ] Add block reorganization handling
- [ ] Add RPC fallback for missed events

#### 3. Offer Parameter Fetching (HIGH PRIORITY)
- [ ] Implement `fetchOfferParams()` to read from PreLiquidation offer contract:
  - `marketId`, `preLLTV`, `preLCF1`, `preLCF2`, `preLIF1`, `preLIF2`
  - `oracleAddress`, `expiry`
- [ ] Implement `checkAuthorization()` to call `Morpho.isBorrowerAuthorized()`
- [ ] Add caching layer in Redis for offer params

#### 4. Bundler3 Integration (HIGH PRIORITY)
- [ ] Build `onPreLiquidate()` calldata encoding
- [ ] Implement Odos API integration (`POST /sor/quote/v2`)
- [ ] Implement 1inch API integration (fallback)
- [ ] Build complete Bundler3 multicall payload:
  1. Pre-liquidate call
  2. Swap call
  3. Repay call
  4. Profit extraction call
- [ ] Add multicall encoding with proper ABI

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
- [ ] Implement `executePreLiquidation()` transaction builder
- [ ] Add nonce management integration
- [ ] Add gas estimation and price oracle
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
- [ ] Add pre-liq execution path to executor
- [ ] Add fallback to standard Morpho liquidation

#### 10. Testing & Validation (HIGH PRIORITY)
- [ ] Unit tests for CREATE2 address computation
- [ ] Unit tests for effective parameter calculation
- [ ] Unit tests for profit estimation
- [ ] Integration tests with Bundler3
- [ ] Fork tests on Base/Arbitrum/Optimism
- [ ] Dry-run mode for pre-liq (no actual execution)

#### 11. Configuration (MEDIUM PRIORITY)
- [ ] Add pre-liq specific config section to `config.yaml`
- [ ] Add environment variables:
  - `MORPHO_PRELIQ_POLL_MS`
  - `MORPHO_PRELIQ_MAX_HF`
  - `PRELIQ_MIN_LIQUIDITY_SCORE`
  - `PRELIQ_MAX_ORACLE_DIVERGENCE_BPS`
  - `PRELIQ_MIN_INCENTIVE_BPS`
  - `PRELIQ_MIN_NET_PROFIT_USD`
- [ ] Add market-specific pre-liq enablement flags

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
