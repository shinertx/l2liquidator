# Morpho Blue Addresses and Markets

## Protocol Overview
Morpho Blue is a permissionless lending primitive with:
- **Isolated markets** (each market = unique risk parameters)
- **Pre-liquidations** (borrower-opt-in partial closes)
- **Atomic callbacks** (flash loan liquidations with callbacks)
- **LLTV (Loan-to-Liquidation-Threshold-Value)** based risk model

---

## Base Chain (8453)

### Core Contract
- **Morpho Blue:** `0xBBBBBbbBBb9cC5e90e3b3Af64bdAf62C37EEffCb`

### Key Markets (Largest TVL)

#### 1. WETH/USDC Market
- **Loan Asset:** USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- **Collateral:** WETH (`0x4200000000000000000000000000000000000006`)
- **LLTV:** 86% (0.86e18)
- **Oracle:** Chainlink WETH/USD
- **IRM:** Adaptive Curve IRM

#### 2. cbETH/USDC Market
- **Loan Asset:** USDC
- **Collateral:** cbETH (`0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22`)
- **LLTV:** 86%
- **Oracle:** Chainlink cbETH/USD

#### 3. wstETH/USDC Market
- **Loan Asset:** USDC
- **Collateral:** wstETH (`0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452`)
- **LLTV:** 86%
- **Oracle:** Chainlink wstETH/USD

#### 4. WETH/cbETH Market
- **Loan Asset:** cbETH
- **Collateral:** WETH
- **LLTV:** 94.5%
- **Oracle:** WETH/cbETH price feed

#### 5. wstETH/WETH Market
- **Loan Asset:** WETH
- **Collateral:** wstETH
- **LLTV:** 94.5%
- **Oracle:** wstETH/WETH price feed

---

## Ethereum Mainnet (1) - Optional

### Core Contract
- **Morpho Blue:** `0xBBBBBbbBBb9cC5e90e3b3Af64bdAf62C37EEffCb`

### Top Markets
- WETH/USDC (86% LLTV)
- wstETH/USDC (86% LLTV)
- wstETH/WETH (94.5% LLTV)
- cbETH/USDC (86% LLTV)

---

## Liquidation Model

### Traditional Liquidation (`liquidate()`)
```solidity
function liquidate(
    MarketParams memory marketParams,
    address borrower,
    uint256 seizedAssets,
    uint256 repaidShares,
    bytes memory data
) external returns (uint256, uint256)
```
- Liquidator repays debt
- Receives collateral at discount (LLTV-based)
- Gas-efficient single call

### Pre-Liquidation (New!)
Borrowers can opt-in to pre-liquidations:
- Partial position closes before full liquidation
- Smaller discount for liquidator (incentive to act early)
- Reduces bad debt risk
- Borrower saves on full liquidation penalties

---

## Key Differences from Aave v3

| Feature | Aave v3 | Morpho Blue |
|---------|---------|-------------|
| **Market Model** | Pool-based | Isolated pairs |
| **Risk Parameters** | Protocol-wide | Per-market (LLTV) |
| **Liquidation Bonus** | Fixed per asset | Based on LLTV |
| **Flash Loans** | Separate contract | Built-in callbacks |
| **Partial Liquidations** | Yes (50% max) | Yes (flexible) |
| **Pre-Liquidations** | No | Yes (opt-in) |
| **Governance** | DAO-managed | Permissionless |

---

## Market Discovery

### GraphQL API
- **Endpoint:** `https://blue-api.morpho.org/graphql`
- **Query:**
```graphql
query {
  marketPositions(
    where: { healthFactor_lt: 1.05 }
    first: 100
  ) {
    items {
      id
      healthFactor
      user { address }
      market {
        uniqueKey
        loanAsset { symbol address decimals }
        collateralAsset { symbol address decimals }
        lltv
        oracleAddress
        irmAddress
      }
      state {
        borrowAssets
        collateral
        borrowShares
      }
    }
  }
}
```

### Subgraph (Alternative)
- **Base:** Not yet deployed
- **Mainnet:** `https://api.thegraph.com/subgraphs/name/morpho-org/morpho-blue`

---

## Liquidation Parameters

### Health Factor Calculation
```
healthFactor = (collateralValue * LLTV) / debtValue
```
- healthFactor < 1.0 = liquidatable
- healthFactor < 1.05 = risky (pre-liquidation target)

### Liquidation Bonus
Calculated from LLTV:
```
bonus = (1 - LLTV) * safetyMargin
```
Examples:
- 86% LLTV → ~10-14% max bonus
- 94.5% LLTV → ~5-5.5% max bonus

### Close Factor
- **Flexible:** Can liquidate any amount up to full position
- **Optimal:** Usually 50% for partial liquidations
- **Full:** 100% for severely underwater positions

---

## Flash Loan Integration

Morpho Blue has **built-in flash loans** with callbacks:

```solidity
function flashLoan(
    address token,
    uint256 assets,
    bytes calldata data
) external
```

Callback:
```solidity
function onMorphoFlashLoan(
    address caller,
    address token,
    uint256 assets,
    uint256 fee,
    bytes calldata data
) external returns (bytes32);
```

**Advantage:** No need for external flash loan providers (Aave/Balancer)

---

## Revenue Potential

### Base Chain Markets
| Market | TVL | Utilization | Liquidation Volume/Day |
|--------|-----|-------------|----------------------|
| WETH/USDC | $50M+ | 70-80% | $100-500K |
| cbETH/USDC | $20M+ | 60-70% | $50-200K |
| wstETH/USDC | $30M+ | 65-75% | $75-300K |
| wstETH/WETH | $15M+ | 80-85% | $50-150K |

**Expected Revenue:** $300-1,500/day
- Lower competition (newer protocol)
- Higher bonuses than Compound V3
- Built-in flash loans (lower costs)
- Pre-liquidation opportunities

---

## Configuration Requirements

### Environment Variables
```bash
MORPHO_BLUE_GRAPHQL_ENDPOINT=https://blue-api.morpho.org/graphql
MORPHO_BLUE_HF_THRESHOLD=1.05
MORPHO_BLUE_FIRST=500
MORPHO_BLUE_CHAIN_IDS=8453  # Base only (or 1,8453 for mainnet)
```

### Config.yaml Markets
Each market needs:
- `protocol: morphoblue`
- `chainId: 8453` (Base)
- `debtAsset` (loan token symbol)
- `collateralAsset` (collateral token symbol)
- `enabled: true`

---

## Documentation
- **Docs:** https://docs.morpho.org/
- **GitHub:** https://github.com/morpho-org/morpho-blue
- **API:** https://blue-api.morpho.org/
- **Analytics:** https://app.morpho.org/

---

## Notes
- Morpho Blue is **permissionless** - anyone can create markets
- Markets are **isolated** - bad debt in one doesn't affect others
- **LLTV-based** risk model is more capital efficient than Aave
- **Pre-liquidations** reduce bad debt and improve borrower UX
- **Lower competition** than Aave v3 (newer, less bot saturation)
