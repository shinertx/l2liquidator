# L2 Liquidator System Architecture

**Last Updated:** October 17, 2025  
**Status:** Production (with Pre-Liquidation Alpha integrated)

---

## Table of Contents

1. [System Overview](#system-overview)
2. [High-Level Architecture](#high-level-architecture)
3. [Core Components](#core-components)
4. [Data Flow](#data-flow)
5. [Protocol Integration](#protocol-integration)
6. [Execution Paths](#execution-paths)
7. [Infrastructure](#infrastructure)
8. [Monitoring & Observability](#monitoring--observability)
9. [Deployment Architecture](#deployment-architecture)

---

## System Overview

### Purpose
Automated liquidation engine that maximizes profit by liquidating undercollateralized positions across Aave v3 and Morpho Blue on L2 networks (Arbitrum, Optimism, Base, Polygon).

### Key Features
- **Multi-Protocol**: Aave v3 + Morpho Blue (with pre-liquidation support)
- **Multi-Chain**: 4 L2 networks with independent agents
- **Real-Time**: Event-driven + polling hybrid indexing
- **Profit-Optimized**: Route optimization, adaptive thresholds, gas-aware execution
- **Risk-Managed**: Dry-run mode, throttling, slippage protection, profit floors

### Performance Targets
- **Capture Rate**: ≥90% of profitable opportunities
- **Revert Rate**: <2% of submitted transactions
- **Inclusion Latency**: p95 <100ms from discovery to on-chain
- **Target Scale**: $MM/day notional volume

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ORCHESTRATOR                                   │
│                         (offchain/orchestrator.ts)                          │
│                                                                             │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌───────────┐ │
│  │ Chain Agent │    │ Chain Agent  │    │ Chain Agent │    │   Chain   │ │
│  │   (Base)    │    │  (Arbitrum)  │    │  (Optimism) │    │  Agent    │ │
│  │             │    │              │    │             │    │ (Polygon) │ │
│  └──────┬──────┘    └──────┬───────┘    └──────┬──────┘    └─────┬─────┘ │
│         │                  │                    │                 │       │
└─────────┼──────────────────┼────────────────────┼─────────────────┼───────┘
          │                  │                    │                 │
          ▼                  ▼                    ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DISCOVERY LAYER                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────┐        ┌──────────────────────┐                 │
│  │   Aave v3 Indexer    │        │ Morpho Blue Indexer  │                 │
│  │  (aave_indexer.ts)   │        │ (morphoblue_indexer) │                 │
│  │                      │        │                      │                 │
│  │ • Subgraph polling   │        │ • GraphQL API poll   │                 │
│  │ • Event streaming    │        │ • HF ≤ 1.05          │                 │
│  │ • HF < 1.0 filter    │        │ • Pre-liq enrichment │                 │
│  │                      │        │   (1.0 < HF < 1.05)  │                 │
│  └──────────┬───────────┘        └──────────┬───────────┘                 │
│             │                               │                             │
│             │    ┌────────────────────┐     │                             │
│             └────▶ Realtime Watcher   ◀─────┘                             │
│                  │ (price_watcher.ts) │                                   │
│                  │ • WebSocket events │                                   │
│                  │ • Predictive scan  │                                   │
│                  └────────────────────┘                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CANDIDATE PIPELINE                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────┐    ┌──────────────┐    ┌────────────────┐             │
│  │ Policy Filters │───▶│  Enrichment  │───▶│   Validation   │             │
│  │                │    │              │    │                │             │
│  │ • Asset deny   │    │ • Token meta │    │ • HF check     │             │
│  │ • Market check │    │ • Prices     │    │ • Gap check    │             │
│  │ • Throttling   │    │ • Routes     │    │ • Sequencer    │             │
│  │ • Zero exposure│    │ • Pre-liq    │    │                │             │
│  └────────────────┘    └──────────────┘    └────────────────┘             │
│                                                     │                      │
└─────────────────────────────────────────────────────┼───────────────────────┘
                                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SCORING ENGINE                                   │
│                         (simulator/simulate.ts)                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────┐        │
│  │                    PRE-LIQUIDATION SCORING                     │        │
│  │                  (Morpho Blue: 1.0 < HF < 1.05)                │        │
│  │                                                                │        │
│  │  1. Expiry Check      → Reject if expired                     │        │
│  │  2. Incentive Floor   → Reject if < 1.5%                      │        │
│  │  3. Close Factor      → Validate 0 < CF ≤ 1                   │        │
│  │  4. Price Validation  → Oracle + DEX gap check                │        │
│  │  5. Liquidity Score   → Route quoting                         │        │
│  │  6. Profit Floor      → Net profit ≥ floorBps                 │        │
│  │  7. Gas Cap           → Total gas ≤ gasCapUsd                 │        │
│  │                                                                │        │
│  │  ✅ Pass → Use preliq CF/LIF, mark for Bundler3              │        │
│  │  ❌ Fail → Fall back to standard parameters                   │        │
│  └────────────────────────────────────────────────────────────────┘        │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────┐        │
│  │                    STANDARD LIQUIDATION SCORING                │        │
│  │              (Aave v3 + Morpho Blue: HF < 1.0)                 │        │
│  │                                                                │        │
│  │  • Repay calculation (close factor × debt)                    │        │
│  │  • Seize calculation (repay × bonus)                          │        │
│  │  • Route optimization (UniV3, Solidly, etc)                   │        │
│  │  • Gas estimation (L1 + L2 fees)                              │        │
│  │  • Profit calculation (proceeds - costs)                      │        │
│  │  • Floor validation (netBps ≥ policy.floorBps)                │        │
│  └────────────────────────────────────────────────────────────────┘        │
│                                                                             │
│  Output: Plan { repayAmount, seizeAmount, route, preliq?, ... }            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           EXECUTION LAYER                                   │
│                      (executor/build_tx.ts + send_tx.ts)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────┐          │
│  │                    EXECUTION PATH SELECTION                  │          │
│  │                                                              │          │
│  │  if (plan.preliq?.useBundler) {                             │          │
│  │    ┌───────────────────────────────────────────┐            │          │
│  │    │      BUNDLER3 EXECUTION (Pre-Liq)         │            │          │
│  │    │                                           │            │          │
│  │    │  1. onPreLiquidate(offer, borrower, ...)│            │          │
│  │    │  2. Swap collateral → debt (1inch/Odos) │            │          │
│  │    │  3. Repay debt to Morpho                │            │          │
│  │    │  4. Transfer profit to beneficiary      │            │          │
│  │    │                                           │            │          │
│  │    │  ⏳ Pending: Contract deployment          │            │          │
│  │    └───────────────────────────────────────────┘            │          │
│  │  } else {                                                   │          │
│  │    ┌───────────────────────────────────────────┐            │          │
│  │    │    FLASH LOAN EXECUTION (Standard)        │            │          │
│  │    │                                           │            │          │
│  │    │  1. Flash loan from Aave/Morpho          │            │          │
│  │    │  2. Liquidate position                   │            │          │
│  │    │  3. Swap seized collateral               │            │          │
│  │    │  4. Repay flash loan + premium           │            │          │
│  │    │  5. Keep profit                          │            │          │
│  │    │                                           │            │          │
│  │    │  ✅ Active & Running                      │            │          │
│  │    └───────────────────────────────────────────┘            │          │
│  │  }                                                          │          │
│  └──────────────────────────────────────────────────────────────┘          │
│                                                                             │
│  MEV Protection:                                                            │
│  • Private RPC endpoints (optional)                                        │
│  • Priority fee optimization                                               │
│  • Nonce management                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              L2 NETWORKS                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Base (8453)      Arbitrum (42161)    Optimism (10)      Polygon (137)     │
│  • Aave v3        • Aave v3           • Aave v3          • Aave v3         │
│  • Morpho Blue    • Morpho Blue       • Morpho Blue      • Aave v3 only    │
│  • 22 markets     • Markets active    • Markets active   • Markets active  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Orchestrator (`offchain/orchestrator.ts`)

**Role**: Main coordinator and chain agent manager

**Responsibilities**:
- Spawns independent chain agents (one per chain)
- Merges candidate streams from multiple protocols
- Coordinates policy enforcement (throttling, retry queues)
- Manages metrics aggregation
- Handles graceful shutdown

**Key Features**:
- Unified candidate pipeline (all protocols → single queue)
- Policy retry queue with exponential backoff
- Adaptive threshold integration
- Heartbeat monitoring with stall detection
- Kill switch enforcement

### 2. Discovery Layer

#### Aave v3 Indexer (`offchain/indexer/aave_indexer.ts`)

**Discovery Methods**:
- **Subgraph Polling**: GraphQL queries for positions with HF < threshold
- **Event Streaming**: WebSocket listeners for real-time events (Borrow, Repay, Liquidation)
- **Adaptive Polling**: Backoff on empty results, fast polling on activity

**Output**: Stream of Aave liquidation candidates

#### Morpho Blue Indexer (`offchain/indexer/morphoblue_indexer.ts`)

**Discovery Methods**:
- **GraphQL API**: Polls Morpho Blue API for positions with HF ≤ 1.05
- **Pre-Liq Enrichment**: For candidates with 1.0 < HF < 1.05:
  1. Compute offer address via CREATE2
  2. Check authorization (`Morpho.isAuthorized`)
  3. Fetch offer parameters (preLCF1/2, preLIF1/2, oracle, expiry)
  4. Linear interpolation for effective CF/LIF based on current HF
  5. Validate expiry

**Output**: Stream of Morpho candidates (standard + pre-liq enriched)

**Pre-Liq Integration Status**:
- ✅ Discovery active (HF ≤ 1.05 covers pre-liq range)
- ✅ Enrichment logic implemented and running
- ✅ CREATE2 computation ready (awaiting factory addresses)
- ✅ Authorization checking active
- ✅ Graceful fallback to standard liquidation

#### Realtime Watcher (`offchain/indexer/price_watcher.ts`)

**Functions**:
- WebSocket event listeners (Repay, Borrow, Liquidation events)
- Predictive scanner (monitors positions approaching liquidation)
- Oracle price updates
- DEX price monitoring

### 3. Scoring Engine (`offchain/simulator/simulate.ts`)

**Input**: Candidate with token metadata, prices, routes, optional preliq offer

**Processing**:

1. **Pre-Liquidation Path** (if `candidate.preliq` exists):
   - Validate expiry > now
   - Validate incentive ≥ 1.5%
   - Validate close factor 0 < CF ≤ 1
   - If valid: Use `preliq.effectiveCloseFactor` and `preliq.effectiveLiquidationIncentive`
   - If invalid: Fall back to standard parameters

2. **Standard Scoring** (all candidates):
   - Calculate repay amount (close factor × debt)
   - Calculate seize amount (repay × bonus factor)
   - Quote swap routes (UniV3, Solidly, etc)
   - Estimate gas costs (L1 + L2 components)
   - Calculate net profit (proceeds - repay - gas)
   - Validate against profit floor

3. **Output**: 
   - `Plan` object with execution parameters
   - `plan.preliq = { offerAddress, useBundler: true }` if pre-liq accepted
   - `null` if unprofitable

**Key Features**:
- Multi-route optimization
- L1 data fee calculation (Optimism, Base, Arbitrum)
- Slippage protection
- Min profit enforcement
- Morpho share-based repayment

### 4. Execution Layer

#### Transaction Builder (`offchain/executor/build_tx.ts`)

**Functions**:
- Encodes liquidation calldata
- Builds flash loan callbacks
- Constructs Morpho-specific parameters
- ⏳ Bundler3 multicall construction (pending)

**Protocols Supported**:
- Aave v3: Standard flash loan liquidation
- Morpho Blue: Flash loan with callback OR Bundler3 (pending)

#### Transaction Sender (`offchain/executor/send_tx.ts`)

**Functions**:
- Signs transactions with chain-specific private keys
- Manages nonce tracking
- Submits to RPC (public or private mempool)
- Handles revert detection
- Retry logic with exponential backoff

**MEV Protection** (`offchain/executor/mev_protect.ts`):
- Optional private RPC endpoints
- Priority fee optimization
- Transaction simulation before broadcast

### 5. Protocol Adapters (`offchain/protocols/`)

#### Morpho Blue Adapter (`morphoblue.ts`)

**Interface**:
```typescript
{
  key: 'morphoblue',
  streamCandidates: streamMorphoBlueCandidates,
  pollCandidatesOnce: async (cfg, chain, first) => [...],
  simulate: simulate,
  PlanRejectedError: PlanRejectedError
}
```

**Features**:
- Unified adapter for standard + pre-liq
- Delegates to indexer for discovery
- Delegates to simulator for scoring
- Single protocol key, multiple execution paths

---

## Data Flow

### Standard Liquidation Flow (Aave v3 + Morpho Blue HF < 1.0)

```
1. Discovery
   Indexer polls subgraph/API → Candidate { HF < 1.0, debt, collateral, ... }

2. Policy Filters
   Check denylist, market enabled, throttle, zero exposure → Pass/Skip

3. Enrichment
   Fetch token metadata, oracle prices, build routes → Enriched Candidate

4. Validation
   Check HF, gap, sequencer status → Pass/Skip

5. Scoring
   Calculate repay/seize, quote routes, estimate gas → Plan or null

6. Execution
   Build flash loan tx → Sign → Broadcast → Monitor

7. Settlement
   On-chain: Flash loan → Liquidate → Swap → Repay → Profit
```

### Pre-Liquidation Flow (Morpho Blue 1.0 < HF < 1.05)

```
1. Discovery
   Morpho indexer polls API → Candidate { 1.0 < HF < 1.05, ... }

2. Enrichment (Pre-Liq Specific)
   • Compute offer address via CREATE2
   • Check authorization (Morpho.isAuthorized)
   • Fetch offer params (preLCF1/2, preLIF1/2, expiry, oracle)
   • Linear interpolate effective CF/LIF based on HF
   • Add candidate.preliq = { offerAddress, effectiveCF, effectiveLIF, ... }

3. Policy Filters (Same as standard)
   Check denylist, market enabled, throttle → Pass/Skip

4. Validation (Same as standard)
   Check HF (now with preliq range), gap, sequencer → Pass/Skip

5. Scoring (Pre-Liq Aware)
   • Validate preliq offer (expiry, incentive ≥1.5%, CF valid)
   • If valid: Use preliq.effectiveCF and preliq.effectiveLIF
   • If invalid: Fall back to standard market params
   • Calculate repay/seize, quote routes, estimate gas
   • Output: Plan { ..., preliq: { offerAddress, useBundler: true } }

6. Execution (Future - Pending Contracts)
   Build Bundler3 multicall → Sign → Broadcast → Monitor

7. Settlement (Future)
   On-chain: onPreLiquidate → Swap → Repay → Profit (no flash loan)
```

---

## Protocol Integration

### Aave v3

**Contracts**:
- Pool: Main lending pool contract
- PoolAddressProvider: Registry of protocol contracts
- Liquidator: Our custom flash loan liquidator

**Markets**: 50+ enabled across 4 chains

**Liquidation Logic**:
- Flash loan from pool
- `liquidationCall()` with max close factor
- Seize collateral with protocol bonus (5-10%)
- Swap via DEX
- Repay flash loan + 0.09% premium

### Morpho Blue

**Contracts**:
- Morpho: Main lending protocol (0xBBBB...FFCb)
- Markets: Isolated lending markets (no pool-wide risk)
- Bundler3: Atomic multicall executor (0x2305...BFB)
- PreLiq Factory: CREATE2 deployer for offers (⏳ pending)

**Markets**: 22 enabled on Base, Arbitrum, Optimism

**Standard Liquidation**:
- Flash loan from Morpho
- `liquidate()` with share-based repayment
- Seize collateral with market bonus
- Swap via DEX
- Repay flash loan (no premium)

**Pre-Liquidation** (1.0 < HF < 1.05):
- No flash loan required
- Borrower pre-authorizes offer contract
- Liquidator calls `Bundler3.multicall([
    onPreLiquidate(offer, borrower, seizeParams),
    swap(collateral → debt),
    repay(debt → Morpho),
    transfer(profit → beneficiary)
  ])`
- Atomic execution with better terms for borrower

---

## Execution Paths

### Path 1: Standard Flash Loan (Aave v3 + Morpho Blue)

**Trigger**: HF < 1.0 (or HF < threshold and no valid pre-liq offer)

**Steps**:
1. `flashLoan(debtAsset, repayAmount, params)`
2. In callback:
   - `liquidate(borrower, debtAsset, collateralAsset, repayAmount, receiveAToken: false)`
   - `swap(collateralAmount → debtAsset)` via UniV3/Solidly
   - Validate `amountOut ≥ repayAmount + premium + minProfit`
3. Repay flash loan
4. Keep remaining profit

**Gas Cost**: ~300-500k gas (varies by route complexity)

**Contracts Used**:
- Aave: `Pool`, `Liquidator.sol`
- Morpho: `Morpho`, `MorphoLiquidator.sol`
- DEXes: UniV3 Router, Solidly Router, etc.

### Path 2: Bundler3 Pre-Liquidation (Morpho Blue Only)

**Trigger**: 1.0 < HF < 1.05 AND valid pre-liq offer exists

**Steps** (⏳ Pending Implementation):
1. `Bundler3.multicall([
     abi.encodeCall(PreLiqOffer.onPreLiquidate, (borrower, seizeAmount)),
     abi.encodeCall(SwapRouter.swap, (collateral, debt, seizeAmount)),
     abi.encodeCall(Morpho.repay, (market, repayAmount, borrower)),
     abi.encodeCall(Token.transfer, (beneficiary, profit))
   ])`

2. Atomic execution:
   - PreLiq offer validates authorization
   - Seizes collateral with pre-liq bonus (better than liquidation)
   - Swaps collateral to debt
   - Repays debt to Morpho (reduces HF back above 1.0)
   - Transfers profit to liquidator

**Gas Cost**: ~250-400k gas (no flash loan overhead)

**Advantages**:
- No flash loan premium (save 0.09%)
- Better terms for borrower (save from full liquidation)
- Faster execution (one transaction vs callback)
- Lower gas costs

---

## Infrastructure

### Configuration (`offchain/infra/config.ts`)

**Structure**:
```yaml
chains:
  - id: 8453
    name: base
    enabled: true
    rpc: $RPC_BASE
    contracts: { liquidator: 0x..., pool: 0x... }
    tokens: { USDC: { address, decimals, chainlinkFeed }, ... }

markets:
  - protocol: morphoblue
    chainId: 8453
    debtAsset: USDC
    collateralAsset: wstETH
    enabled: true
    closeFactorBps: 5000
    bonusBps: 800

assets:
  USDC:
    floorBps: 150
    gapCapBps: 50
    slippageBps: 100

risk:
  healthFactorMax: 0.98
  gasCapUsd: 10
  maxRepayUsd: 50000
  failRateCap: 0.3
  dryRun: false
```

**Auto-Sync**:
- `npm run sync:aave` - Regenerates Aave markets from address book
- `npm run sync:morpho` - Updates Morpho Blue token metadata
- `npm run sync:morpho:markets` - Refreshes Morpho market list

### Logging (`offchain/infra/logger.ts`)

**Format**: Structured JSON logs via Pino

**Levels**:
- `10` TRACE: Verbose debugging
- `20` DEBUG: Development info
- `30` INFO: Normal operation
- `40` WARN: Potential issues
- `50` ERROR: Failures requiring attention
- `60` FATAL: System crash

**Key Log Events**:
- `candidate-considered`: Candidate passed filters
- `liquidation-sent`: Transaction broadcast
- `policy-retry-scheduled`: Candidate queued for retry
- `gap-threshold-exceeded`: Oracle-DEX gap too large
- `plan-rejected`: Simulation failed

### Metrics (`offchain/infra/metrics.ts`)

**Prometheus Endpoints**: `http://localhost:9464/metrics`

**Key Metrics**:

**Counters**:
- `candidates_total{chain}` - Candidates processed
- `plans_ready_total{chain}` - Plans generated
- `plans_sent_total{chain}` - Transactions broadcast
- `plans_error_total{chain}` - Execution errors
- `profit_estimated_total_usd{chain,mode}` - Estimated profit
- `preliq_attempt_total{chain}` - Pre-liq attempts
- `preliq_success_total{chain}` - Pre-liq successes

**Gauges**:
- `hit_rate` - Plans sent / plans ready
- `failure_rate{chain}` - Errors / total attempts
- `pnl_per_gas{chain}` - Profit per gas unit
- `adaptive_health_factor_max{chain,pair}` - Dynamic HF thresholds
- `preliq_profit_usd` - Latest pre-liq profit

**Histograms**:
- `simulate_duration_seconds` - Scoring latency
- `send_latency_seconds` - Broadcast latency
- `candidate_health_factor{chain,stage}` - HF distribution

### Database (`offchain/infra/db.ts`)

**PostgreSQL Schema**:

```sql
CREATE TABLE attempts (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  chain_id INTEGER NOT NULL,
  borrower TEXT NOT NULL,
  status TEXT NOT NULL, -- 'sent', 'error', 'throttled', 'policy_skip', 'gap_skip'
  reason TEXT,
  tx_hash TEXT,
  details JSONB
);

CREATE INDEX idx_attempts_borrower ON attempts(chain_id, borrower, timestamp);
CREATE INDEX idx_attempts_status ON attempts(status, timestamp);
```

**Usage**:
- Throttle enforcement (max attempts per borrower per hour)
- Historical analysis
- Failure debugging
- Profit tracking

### Redis (`offchain/infra/redis.ts`)

**Keys**:
- `throttle:{chainId}:{borrower}` - Attempt counter with TTL
- `borrower_intel:{chainId}:{borrower}` - Cached HF for throttle bypass
- `oracle_price:{chainId}:{token}` - Cached prices with TTL

**Usage**:
- Rate limiting
- Price caching (reduce RPC calls)
- Distributed coordination (future: multi-instance)

---

## Monitoring & Observability

### Dashboards

**Prometheus + Grafana**:
- Candidate flow rates per chain
- Hit rate over time
- Failure rate alerting
- Gas cost trends
- Profit metrics (estimated vs realized)
- Pre-liq adoption rate

### Alerting

**Critical Alerts**:
- `failure_rate > 30%` for 5 minutes → Page on-call
- `plans_ready - plans_sent > 100` → Execution stalled
- `sequencer_status = 0` → L2 downtime
- Kill switch engaged → Immediate notification

**Warning Alerts**:
- `gap_skip_total` spike → Oracle issues or DEX liquidity crisis
- `throttled_total` high → Possible retry loop
- `adaptive_gap_cap_bps` > 200 → Volatile market conditions

### Health Checks

**Docker Health Check**:
```bash
curl -f http://localhost:9464/metrics || exit 1
```

**Application Health**:
- Heartbeat every 60s (logs `heartbeat` event)
- Stall detection: If no activity for 120s → fallback poll
- Auto-restart on fatal errors

---

## Deployment Architecture

### Docker Compose

```yaml
services:
  worker:
    build: .
    environment:
      - PRELIQ_ENABLED=1
      - MORPHO_BLUE_HF_THRESHOLD=1.05
      - RPC_BASE=${RPC_BASE}
      - WALLET_PK_BASE=${WALLET_PK_BASE}
    volumes:
      - ./logs:/app/logs
    ports:
      - "9464:9464"
    restart: unless-stopped
    healthcheck:
      test: curl -f http://localhost:9464/metrics
      interval: 30s
      timeout: 10s
      retries: 3
```

### Environment Variables

**Required per Chain**:
- `RPC_{CHAIN}` - RPC endpoint URL
- `WALLET_PK_{CHAIN}` - Private key for execution
- `PRIVTX_{CHAIN}` - Private mempool endpoint (optional)

**Protocol Config**:
- `PRELIQ_ENABLED=1` - Enable pre-liquidation feature
- `MORPHO_BLUE_HF_THRESHOLD=1.05` - Discovery threshold
- `MORPHO_BLUE_CHAIN_IDS=8453,42161,10` - Active chains

**Risk Controls**:
- `DRY_RUN=1` - Test mode (no real transactions)
- `GAS_CAP_USD=10` - Max gas per transaction
- `MAX_REPAY_USD=50000` - Max notional per liquidation
- `FAIL_RATE_CAP=0.3` - Auto-stop threshold

### Deployment Process

1. **Build**:
   ```bash
   npm run build
   ```

2. **Verify**:
   ```bash
   npm run test
   node dist/offchain/tools/preflight_check.js
   ```

3. **Deploy**:
   ```bash
   docker-compose up -d worker
   ```

4. **Monitor**:
   ```bash
   docker logs -f l2liquidator-worker-1
   curl http://localhost:9464/metrics | grep preliq
   ```

### Rollback

```bash
git checkout <previous-commit>
npm run build
docker-compose restart worker
```

---

## Security Considerations

### Private Key Management
- One private key per chain
- Stored in `.env` (gitignored)
- Never logged or exposed in metrics
- Separate keys for prod vs staging

### Flash Loan Safety
- Always validate callback sender
- Enforce minimum profit on-chain
- Slippage protection via `amountOutMin`
- Revert on unexpected states

### MEV Protection
- Optional private RPC endpoints
- Transaction simulation before broadcast
- Priority fee optimization
- Avoid predictable patterns

### Rate Limiting
- Max attempts per borrower per hour
- Exponential backoff on retries
- Throttle bypass for significant HF drops
- Kill switch for emergency shutdown

### Oracle Validation
- Chainlink price feed staleness checks
- Oracle-DEX gap thresholds
- Fallback to TWAP when stale
- Reject if divergence too large

---

## Future Enhancements

### Short-Term (Q4 2025)
- ✅ Pre-liquidation integration (COMPLETE)
- ⏳ Deploy PreLiquidation Factory contracts
- ⏳ Implement Bundler3 execution path
- ⏳ Integrate Odos + 1inch API for swap routing

### Medium-Term (Q1 2026)
- Add Compound v3 support
- Add Radiant Capital support
- Multi-instance coordination via Redis
- Advanced routing (split orders, multi-hop)

### Long-Term (Q2+ 2026)
- Cross-chain liquidations (bridge + liquidate)
- Intent-based execution (RFQ integration)
- ML-based predictive liquidation timing
- Automated parameter tuning via RL

---

## Appendix

### Contract Addresses

**Morpho Blue** (all chains):
- `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`

**Bundler3** (Base, ARB, OP):
- `0x23055618898e202386e6c13955a58D3C68200BFB`

**PreLiq Factory** (⏳ pending deployment):
- Base: TBD
- Arbitrum: TBD
- Optimism: TBD

**Liquidator Contracts**:
- Base: See `config.yaml`
- Arbitrum: See `config.yaml`
- Optimism: See `config.yaml`
- Polygon: See `config.yaml`

### Key Files Reference

**Core Logic**:
- `offchain/orchestrator.ts` - Main coordinator (1400+ lines)
- `offchain/indexer/morphoblue_indexer.ts` - Morpho discovery + pre-liq enrichment (350 lines)
- `offchain/simulator/simulate.ts` - Scoring engine with pre-liq support (600 lines)
- `offchain/executor/build_tx.ts` - Transaction construction (800 lines)

**Configuration**:
- `config.yaml` - Markets, tokens, risk params (auto-generated)
- `.env` - Environment variables (gitignored)
- `tsconfig.json` - TypeScript configuration

**Smart Contracts**:
- `contracts/Liquidator.sol` - Aave flash loan liquidator
- `contracts/MorphoBlueLiquidator.sol` - Morpho flash loan liquidator

### Glossary

- **HF (Health Factor)**: Collateral value / (Debt value × Liquidation Threshold)
- **Close Factor**: % of debt that can be repaid in one liquidation
- **Liquidation Bonus**: Extra collateral seized (incentive for liquidators)
- **Flash Loan**: Uncollateralized loan repaid in same transaction
- **Pre-Liquidation**: Early liquidation with better terms (1.0 < HF < threshold)
- **Bundler3**: Morpho's atomic multicall executor
- **CREATE2**: Deterministic contract address generation
- **WAD**: 10^18 (standard DeFi decimal precision)

---

**Document Version**: 1.0  
**Last Updated**: October 17, 2025  
**Status**: Pre-Liquidation Alpha integrated and running
