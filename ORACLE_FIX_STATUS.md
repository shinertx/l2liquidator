# Oracle ETH→USD Conversion Fix - Status Report

**Date:** October 16, 2025  
**Status:** ⚠️ Implemented but Blocked by Chainlink Feed Issues

## Problem Addressed

ETH-denominated Chainlink feeds (rsETH, weETH, wstETH) were returning prices in ETH units but being treated as USD, causing:
- Zero/missing prices in subgraph fallback
- Markets being skipped due to `subgraph-price-zero` 
- Lost liquidation opportunities on LST assets

## Solution Implemented

### 1. Core Oracle Logic (`offchain/indexer/price_watcher.ts`)

```typescript
// NEW: Detects feedDenomination='eth' and auto-converts to USD
async function cachedOraclePrice(client, token, chain?) {
  const detail = await cachedOracleDetail(client, token);
  
  if (token.feedDenomination === 'eth' && chain) {
    const wethToken = Object.values(chain.tokens).find(t => 
      t.address.toLowerCase() === chain.tokens.WETH?.address.toLowerCase()
    );
    if (wethToken?.chainlinkFeed) {
      const ethUsdPrice = await cachedOraclePrice(client, wethToken);
      if (ethUsdPrice > 0) {
        return detail.priceUsd * ethUsdPrice; // Convert ETH → USD
      }
    }
    return undefined; // Fail safe if ETH/USD unavailable
  }
  
  return detail.priceUsd;
}
```

### 2. Subgraph Fallback (`offchain/indexer/aave_indexer.ts`)

```typescript
// FIXED: Now passes chain parameter for ETH-denominated conversion
const tokenPriceUsd = await oraclePriceUsd(ctx.client!, tokenEntry.value, chain);
const nativePrice = await oraclePriceUsd(ctx.client!, nativeToken, chain);
```

### 3. Orchestrator (`offchain/orchestrator.ts`)

```typescript
// UPDATED: All oracle calls now pass chain context
let debtPriceUsd = await oraclePriceUsd(client, debtToken, chain);
let collPriceUsd = await oraclePriceUsd(client, collateralToken, chain);
const nativePrice = await oraclePriceUsd(client, nativeToken, chain);
```

### 4. Configuration (`config.yaml`)

Added `feedDenomination: eth` to all ETH-denominated feeds:

```yaml
# Arbitrum
rsETH:
  chainlinkFeed: "0xb0EA543f9F8d4B818550365d13F66Da747e1476A"
  feedDenomination: eth
weETH:
  chainlinkFeed: "0x517276B5972C4Db7E88B9F76Ee500E888a2D73C3"
  feedDenomination: eth
wstETH:
  chainlinkFeed: "0x87fE1503beFBF98C35c7526B0c488d950F822C0F"
  feedDenomination: eth

# Optimism
wstETH:
  chainlinkFeed: "0x724E47194d97263ccb71FDad84b4fed18a8be387"
  feedDenomination: eth

# Base
weETH:
  chainlinkFeed: "0xFc4d1d7a8FD1E6719e361e16044b460737F12C44"
  feedDenomination: eth
wrsETH:
  chainlinkFeed: "0x567E7f3DB2CD4C81872F829C8ab6556616818580"
  feedDenomination: eth
wstETH:
  chainlinkFeed: "0x56038D3998C42db18ba3B821bD1EbaB9B678e657"
  feedDenomination: eth

# Polygon
wstETH:
  chainlinkFeed: "0xBD96b5ABBC6048c28184b462167E487533F2e35E"
  feedDenomination: eth
```

## Current Blocker

### Chainlink Feed Failures

Docker logs show widespread `aggregator-proxy-fallback` errors:

```
The contract function "aggregator" reverted.
Contract Call:
  address:   0x87fe1503befbf98c35c7526b0c488d950f822c0f (wstETH/ETH)
  address:   0xbd96b5abbc6048c28184b462167e487533f2e35e (Polygon wstETH)
  ... (30+ feeds affected)
```

**Root Cause:** Chainlink feeds using proxy contracts that don't expose `aggregator()` function in expected ABI.

**Impact:** Oracle prices return `undefined` → ETH→USD conversion never triggers → Still seeing `subgraph-price-zero`

## Evidence from Live Logs

```json
{"chainId":8453,"symbol":"wstETH","role":"collateral","msg":"subgraph-price-zero"}
{"chainId":42161,"missingCollateralPrices":["wstETH","weETH","rsETH"]}
{"chainId":137,"missingCollateralPrices":["wstETH"]}
```

## Files Modified

1. ✅ `offchain/indexer/price_watcher.ts` - Core conversion logic
2. ✅ `offchain/indexer/aave_indexer.ts` - Subgraph fallback integration  
3. ✅ `offchain/orchestrator.ts` - Main liquidation pipeline
4. ✅ `config.yaml` - Asset feed denomination flags
5. ✅ Docker image rebuilt and restarted

## Recommended Next Actions

### Immediate (High Priority)
1. **Investigate Chainlink ABI mismatch:**
   - Check if feeds use AccessControlledOffchainAggregator vs AggregatorV3Interface
   - May need to call feeds directly without proxy resolution
   - Consider using `description()` + direct `latestRoundData()` instead of `aggregator()`

2. **Implement DEX TWAP Fallback:**
   ```typescript
   if (oraclePriceUsd === undefined) {
     // Try Uniswap V3 TWAP as ultimate fallback
     const twapPrice = await getDexTwapPrice(client, token, chain);
   }
   ```

3. **Add Debug Logging:**
   - Log successful vs failed feed reads
   - Track which feeds work vs fail
   - Measure conversion success rate

### Medium Priority
- Fix policy retry backoff (still looping on healthy borrowers)
- Resolve Base SPL quoter saturation
- Address bridge liquidity deficits

### Monitoring
```bash
# Check for missing price improvements
docker logs l2liquidator-worker-1 --tail 100 | grep "subgraph-price-zero" | wc -l

# Verify oracle fallback attempts  
docker logs l2liquidator-worker-1 | grep "subgraph-price-fallback"

# Check successful conversions
docker logs l2liquidator-worker-1 | grep "feedDenomination.*eth"
```

## Architecture Decision

The ETH→USD conversion architecture is **correct and future-proof:**
- ✅ Clean separation of concerns
- ✅ Explicit denomination metadata in config
- ✅ Automatic conversion at oracle layer
- ✅ No business logic changes needed

**Blocked only by Chainlink feed access issues**, not design flaws.

---

**Conclusion:** Fix is ready but needs Chainlink feed debugging before validation. The conversion logic itself is sound and will work once oracle prices load successfully.
