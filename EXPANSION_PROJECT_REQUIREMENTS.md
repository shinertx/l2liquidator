# L2 Liquidator Expansion Project Requirements

**Objective:** Expand from Aave-only to multi-protocol liquidation engine covering less saturated venues with ordering advantages.

**Current State:** Aave v3 on Arbitrum/Optimism/Base/Polygon - 0 liquidations due to market saturation

**Target State:** Multi-protocol coverage with competitive ordering advantages generating $2K-8K/day

---

## PHASE 1: SEAMLESS PROTOCOL (BASE)

### Overview
Seamless is an Aave v3 fork on Base with active liquidations and less bot competition.

### Technical Requirements

#### 1.1 Protocol Integration
- **Contract Addresses:**
  - Pool: Seamless pool address on Base
  - Pool Address Provider: Seamless address provider
  - Oracle: Seamless price oracle
- **API Surface:** Identical to Aave v3 (same function signatures)
- **Markets:** WETH, USDC, cbETH, wstETH collateral/debt pairs

#### 1.2 Configuration
- Add `seamless` protocol type to config schema
- Add Seamless markets to config.yaml
- Configure liquidation bonuses per asset (5-10% typical)
- Set closeFactorBps per market (start 5000 = 50%)

#### 1.3 Indexer Integration
- Extend `aave_indexer.ts` to support Seamless (or create `seamless_indexer.ts`)
- Query Seamless subgraph for user positions
- Parse Seamless reserve data (same format as Aave)
- Health factor calculation (reuse Aave logic)

#### 1.4 Execution Integration
- Extend `Liquidator.sol` to support Seamless pool
- Or create `SeamlessLiquidator.sol` (same interface as Aave)
- Flash loan callback compatibility
- Route seized collateral through Base DEXes

#### 1.5 Testing
- Dry-run mode on Base Seamless positions
- Verify health factor calculations match on-chain
- Test flash loan -> liquidate -> swap -> repay flow
- Validate profit calculations

### Success Criteria
- [ ] Seamless positions indexed and monitored
- [ ] Health factors calculated correctly
- [ ] Liquidations execute successfully in dry-run
- [ ] First profitable liquidation on Seamless
- [ ] Zero reverts in first 24 hours

### Expected Impact
- **New liquidation opportunities:** 10-30/day on Base
- **Competition level:** Medium (less than Aave mainnet)
- **Revenue:** $200-1K/day

---

## PHASE 2: COMPOUND V3 (ARBITRUM + BASE)

### Overview
Compound v3 has ongoing liquidations with 5-7% bonuses and less bot density than Aave.

### Technical Requirements

#### 2.1 Protocol Integration
- **Contract Addresses:**
  - Comet contracts per market (USDC, WETH markets)
  - Comet Factory
  - Price feeds (Compound uses Chainlink)
- **API Surface:** Different from Aave (absorb() vs liquidationCall())
- **Markets:** USDC base asset with ETH/wBTC/LINK/UNI as collateral

#### 2.2 Configuration
- Add `compoundv3` protocol type to config schema
- Define Compound markets (market = base asset + collateral assets)
- Configure liquidation incentives per market (read from Comet)
- Set borrowCollateralFactor, liquidateCollateralFactor thresholds

#### 2.3 Indexer Integration
- Create `compound_indexer.ts`
- Query Compound v3 subgraph or use direct RPC calls
- Parse borrower positions (getBorrowInfo, getCollateralInfo)
- Health factor = collateralValue / (borrowValue * liquidateCollateralFactor)
- Detect underwater positions (collateral < borrow * liquidateCollateralFactor)

#### 2.4 Smart Contract Adapter
- Create `CompoundV3Liquidator.sol`
- Implement absorb() liquidation flow:
  - Flash loan borrow
  - Call comet.absorb(borrower, [collateral tokens])
  - Receive seized collateral
  - Swap to base asset
  - Repay flash loan
  - Keep profit
- Handle multiple collateral types in single liquidation

#### 2.5 Execution Integration
- Extend orchestrator to handle Compound protocol
- Build liquidation plans for Compound markets
- Calculate profit = seizedValue * (1 + liquidationIncentive) - repayValue - gas
- Route swaps for exotic collateral (LINK, UNI, etc.)

#### 2.6 Testing
- Test absorb() on Arbitrum testnet
- Verify collateral seizure calculations
- Test multi-collateral liquidations
- Validate profit extraction

### Success Criteria
- [ ] Compound positions indexed on Arbitrum and Base
- [ ] Underwater positions detected correctly
- [ ] absorb() liquidations execute successfully
- [ ] Multi-collateral handling works
- [ ] First profitable Compound liquidation
- [ ] <2% revert rate

### Expected Impact
- **New liquidation opportunities:** 20-50/day across Arbitrum + Base
- **Competition level:** Low-Medium (less bot density)
- **Revenue:** $500-2.5K/day

---

## PHASE 3: ARBITRUM TIMEBOOST INTEGRATION

### Overview
Timeboost allows express lane bids to get transactions included before competitors on Arbitrum.

### Technical Requirements

#### 3.1 Timeboost Infrastructure
- **Auction System:**
  - Express lane controller address
  - Bidding mechanism (off-chain or on-chain)
  - Express lane duration (typically per round)
- **RPC Integration:**
  - Timeboost-enabled RPC endpoint
  - Express lane transaction submission
  - Fallback to standard mempool

#### 3.2 Bid Strategy Engine
- Create `timeboost_bidder.ts`
- Calculate optimal bid:
  - `maxBid = expectedLiquidationProfit * captureRate - minProfit`
  - `bid = min(maxBid, competitorBid + minIncrement)`
- Dynamic bidding based on:
  - Liquidation bonus size
  - Gas costs
  - Competition level
  - Historical win rate

#### 3.3 Execution Flow
- Detect liquidation opportunity on Arbitrum
- Estimate profit including Timeboost cost
- If `profit - timeboostBid > minProfit`:
  - Submit express lane bid
  - If won: submit tx via express lane
  - If lost: fallback to private RPC or skip
- Track win rate and adjust bidding

#### 3.4 Monitoring & Analytics
- Track express lane wins vs losses
- Measure ROI on Timeboost spending
- Compare capture rate with vs without Timeboost
- Adjust bidding parameters based on performance

### Success Criteria
- [ ] Express lane bids submitted successfully
- [ ] Transactions included via express lane
- [ ] Positive ROI on Timeboost spending (profit > bids)
- [ ] Capture rate increased by 30%+ on Arbitrum
- [ ] Bidding strategy optimizes over time

### Expected Impact
- **Capture rate improvement:** +50-100% on Arbitrum
- **Additional revenue:** +$500-2K/day from won races
- **Competitive advantage:** Win against other bots

---

## PHASE 4: MORPHO BLUE PRE-LIQUIDATIONS (BASE)

### Overview
Morpho Blue pre-liquidations allow borrower-opt-in partial closes with atomic callbacks, less competition.

### Technical Requirements

#### 4.1 Protocol Integration
- **Contract Addresses:**
  - Morpho Blue singleton
  - PreLiquidationFactory
  - Market IDs (each market = unique lending pool)
- **Pre-liquidation Flow:**
  - borrower enables pre-liquidation
  - bot monitors for pre-liq-enabled positions near threshold
  - call preLiquidate() with callback
  - receive collateral, swap, repay in callback
  - smaller bonus but atomic and frequent

#### 4.2 Configuration
- Add `morphoblue` protocol type
- Define Morpho markets (loanToken, collateralToken, oracle, irm, lltv)
- Configure pre-liquidation thresholds per market
- Set target LTV for pre-liquidations

#### 4.3 Indexer Integration
- Create `morpho_indexer.ts`
- Query Morpho Blue positions
- Filter for pre-liquidation-enabled borrowers
- Monitor LTV approaching thresholds
- Calculate partial close amounts

#### 4.4 Smart Contract Adapter
- Create `MorphoBlueLiquidator.sol` with callback interface
- Implement preLiquidate flow:
  - Call morpho.preLiquidate(marketId, borrower, seizedAssets, repaidShares)
  - Receive callback with collateral
  - Swap collateral to loan token
  - Return repayment in callback
  - Keep difference as profit
- Handle atomic execution (no flash loan needed)

#### 4.5 Strategy Development
- Build pre-liquidation opportunity detector
- Calculate optimal partial close size
- Estimate profit per pre-liquidation (smaller but frequent)
- Queue pre-liquidations when LTV crosses threshold

#### 4.6 Testing
- Test pre-liquidation on Base testnet
- Verify callback execution
- Test atomic swap + repay flow
- Validate profit extraction

### Success Criteria
- [ ] Morpho positions indexed on Base
- [ ] Pre-liq-enabled borrowers identified
- [ ] preLiquidate() executes successfully
- [ ] Atomic callback flow works
- [ ] First profitable pre-liquidation
- [ ] Multiple pre-liqs per borrower (recurring revenue)

### Expected Impact
- **New opportunity type:** Pre-liquidations (different from HF < 1.0)
- **Frequency:** 30-100/day (more frequent, smaller size)
- **Competition level:** Low (new feature, less known)
- **Revenue:** $300-1.5K/day

---

## PHASE 5: SAFETY & OPTIMIZATION (ONGOING)

### 5.1 L2 Sequencer Uptime Monitoring
- **Requirement:** Never liquidate during sequencer downtime
- **Implementation:**
  - Query Chainlink L2 Sequencer Uptime feeds
  - Check sequencer status before every liquidation
  - Implement grace period after sequencer restart
  - Enable post-outage opportunity capture

### 5.2 Odos Router Integration
- **Requirement:** Better DEX routing for exotic collateral
- **Implementation:**
  - Add Odos API integration
  - Compare Odos quotes vs Uniswap
  - Use best route for each swap
  - Aggregate across Aerodrome, Camelot, Uniswap, Curve
- **Expected Impact:** 20-50 bps better execution

### 5.3 Cross-Chain Inventory Management
- **Requirement:** Maintain optimal USDC/ETH inventory per chain
- **Implementation:**
  - Monitor inventory levels per chain
  - Use Across bridge for rebalancing
  - Optimize for low/negative fee windows
  - Prevent inventory shortages blocking liquidations

### 5.4 Monitoring & Alerts
- **Metrics to track:**
  - Liquidations attempted per protocol
  - Success rate per protocol
  - Profit per liquidation
  - Capture rate vs competition
  - Gas costs per chain
  - Timeboost ROI (Arbitrum)
- **Alerts:**
  - Sequencer downtime
  - Failed liquidations (>5% rate)
  - Inventory shortages
  - Abnormal gas prices
  - Zero liquidations for >6 hours

---

## CONFIGURATION SCHEMA CHANGES

### Protocol Type Enum
```yaml
protocol: aavev3 | seamless | compoundv3 | morphoblue
```

### Market Configuration
```yaml
markets:
  - protocol: seamless
    chainId: 8453
    poolAddressProvider: "0x..."
    debtAsset: USDC
    collateralAsset: WETH
    closeFactorBps: 5000
    bonusBps: 500
    enabled: true
    
  - protocol: compoundv3
    chainId: 42161
    cometAddress: "0x..."
    baseAsset: USDC
    collateralAssets: [WETH, wBTC, LINK]
    enabled: true
    
  - protocol: morphoblue
    chainId: 8453
    marketId: "0x..."
    loanToken: USDC
    collateralToken: WETH
    preLiqEnabled: true
    enabled: true
```

---

## SMART CONTRACT ARCHITECTURE

### Current
```
Liquidator.sol (Aave v3 only)
├── Flash loan from Aave
├── liquidationCall()
├── Swap via Uniswap V3
└── Repay flash loan
```

### Target
```
BaseLiquidator.sol (abstract)
├── AaveLiquidator.sol (existing)
├── SeamlessLiquidator.sol (Phase 1)
├── CompoundV3Liquidator.sol (Phase 2)
└── MorphoBlueLiquidator.sol (Phase 4)

Each implements:
- executeFlashLoan()
- liquidate()
- swap()
- extractProfit()
```

---

## TESTING STRATEGY

### Unit Tests
- Protocol adapter tests (mock contracts)
- Health factor calculations
- Profit calculations
- Route caching with different routers

### Integration Tests
- Full liquidation flow per protocol
- Multi-protocol orchestration
- Timeboost bidding logic
- Sequencer uptime gating

### Testnet Deployment
- Deploy to Arbitrum Sepolia, Base Sepolia
- Test with real protocol contracts
- Validate gas estimates
- Test failure modes

### Dry-Run Production
- Monitor mainnet positions
- Simulate liquidations (no execution)
- Validate profitability
- Tune policy parameters

### Gradual Rollout
- Start with small position sizes
- Monitor for 48 hours
- Increase limits gradually
- Full production after 1 week

---

## RISK MANAGEMENT

### Protocol Risks
- **Smart contract bugs:** Start with audited protocols (Aave, Compound)
- **Oracle failures:** Multiple price source validation
- **Flash loan unavailability:** Fallback flash loan sources
- **DEX liquidity:** Check available liquidity before execution

### Execution Risks
- **Gas price spikes:** Gas caps per chain
- **Slippage:** Dynamic slippage limits based on liquidity
- **Reverts:** Track revert rate, disable market if >5%
- **Competition:** Timeboost on Arbitrum, private RPCs elsewhere

### Financial Risks
- **Inventory risk:** Maintain balanced inventory per chain
- **Timeboost overbidding:** Cap bids at 50% of expected profit
- **Failed liquidations:** Min profit thresholds per protocol
- **Bridge costs:** Monitor Across fees for inventory rebalancing

---

## SUCCESS METRICS

### Per Protocol
- Liquidations executed per day
- Success rate (%)
- Average profit per liquidation
- Total revenue per day
- Revert rate (%)

### Overall System
- Total revenue per day: **Target $2K-8K**
- Capture rate vs opportunities: **Target 60%+**
- System uptime: **Target 99.5%+**
- Profit margin after gas: **Target 70%+**

### Competitive Position
- Arbitrum capture rate with Timeboost vs without
- Unique protocols covered vs competitors
- Speed to new protocol support
- Pre-liquidation market share

---

## DELIVERABLES

### Phase 1: Seamless
- [ ] SeamlessLiquidator.sol deployed on Base
- [ ] Seamless indexer integrated
- [ ] Config with Seamless markets
- [ ] First successful Seamless liquidation
- [ ] Documentation

### Phase 2: Compound V3
- [ ] CompoundV3Liquidator.sol deployed on Arbitrum + Base
- [ ] Compound indexer integrated
- [ ] Config with Compound markets
- [ ] Multi-collateral liquidation support
- [ ] First successful Compound liquidation
- [ ] Documentation

### Phase 3: Timeboost
- [ ] Timeboost bidder integrated
- [ ] Express lane submission working
- [ ] Bid optimization strategy
- [ ] ROI tracking dashboard
- [ ] Documentation

### Phase 4: Morpho Blue
- [ ] MorphoBlueLiquidator.sol with callback
- [ ] Pre-liquidation indexer
- [ ] Morpho markets configured
- [ ] First successful pre-liquidation
- [ ] Documentation

### Phase 5: Safety & Optimization
- [ ] Sequencer uptime checks on all chains
- [ ] Odos router integration
- [ ] Cross-chain inventory management
- [ ] Comprehensive monitoring dashboard
- [ ] Alert system operational

---

## DEPENDENCIES

### External Services
- Seamless subgraph (Base)
- Compound v3 subgraph (Arbitrum, Base)
- Morpho Blue subgraph (Base)
- Timeboost RPC endpoint (Arbitrum)
- Odos API
- Across bridge
- Chainlink sequencer feeds

### Internal Prerequisites
- Working Aave v3 liquidator (✅ exists)
- Multi-protocol config schema
- Abstract liquidator base contract
- Protocol-agnostic orchestrator
- Policy engine supporting multiple protocols

---

**EXECUTION ORDER:**
1. Phase 1: Seamless (quick win, easy implementation)
2. Phase 2: Compound V3 (bigger opportunity, moderate complexity)
3. Phase 3: Timeboost (competitive edge, medium complexity)
4. Phase 4: Morpho Blue (blue ocean, new concepts)
5. Phase 5: Ongoing optimization

**ESTIMATED TOTAL IMPACT:** $2K-8K/day revenue after all phases complete.
