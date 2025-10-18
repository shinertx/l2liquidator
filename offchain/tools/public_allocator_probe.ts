/**
 * Morpho Public Allocator Liquidity Intelligence
 * 
 * Polls the Morpho Public Allocator API to get real-time liquidity data
 * for each market. This helps prioritize pre-liquidation opportunities
 * where we know we can exit the collateral position.
 */

type MarketLiquidity = {
  marketId: string;
  chainId: number;
  loanToken: string;
  collateralToken: string;
  supplyAvailable: bigint; // How much can be borrowed
  borrowAvailable: bigint; // How much can be repaid
  incentiveRate: number; // APY for supplying
  lastUpdated: number;
};

type LiquiditySnapshot = {
  timestamp: number;
  markets: Map<string, MarketLiquidity>;
};

const PUBLIC_ALLOCATOR_API = 'https://api.morpho.org/public-allocator'; // TODO: Verify URL
const POLL_INTERVAL_MS = Number(process.env.MORPHO_LIQUIDITY_POLL_MS ?? 30_000);

let currentSnapshot: LiquiditySnapshot = {
  timestamp: 0,
  markets: new Map(),
};

/**
 * Fetch liquidity data from Morpho Public Allocator API
 */
async function fetchLiquidityData(chainId: number): Promise<MarketLiquidity[]> {
  try {
    // TODO: Implement actual API call
    // GET /liquidity?chainId={chainId}
    // Response: { markets: [{ marketId, loanToken, collateralToken, supplyAvailable, borrowAvailable, incentiveRate }] }
    
    return [];
  } catch (err) {
    console.error(`Error fetching liquidity data for chain ${chainId}:`, err);
    return [];
  }
}

/**
 * Get current liquidity snapshot
 */
export function getLiquiditySnapshot(): LiquiditySnapshot {
  return currentSnapshot;
}

/**
 * Get liquidity for specific market
 */
export function getMarketLiquidity(marketId: string): MarketLiquidity | null {
  return currentSnapshot.markets.get(marketId) ?? null;
}

/**
 * Calculate liquidity score (0-100) for a market
 * Higher score = more liquid, easier to exit
 */
export function calculateLiquidityScore(marketId: string, requiredAmount: bigint): number {
  const liquidity = getMarketLiquidity(marketId);
  if (!liquidity) return 0;

  // Score based on:
  // 1. Supply availability (can we borrow enough to repay?)
  // 2. Borrow availability (can we repay the debt?)
  // 3. Incentive rate (is the market incentivized?)

  const supplyRatio = Number(liquidity.supplyAvailable) / Number(requiredAmount);
  const supplyScore = Math.min(supplyRatio * 50, 50); // Max 50 points

  const borrowRatio = Number(liquidity.borrowAvailable) / Number(requiredAmount);
  const borrowScore = Math.min(borrowRatio * 30, 30); // Max 30 points

  const incentiveScore = Math.min(liquidity.incentiveRate * 10, 20); // Max 20 points

  return Math.floor(supplyScore + borrowScore + incentiveScore);
}

/**
 * Start polling liquidity data
 */
export async function startLiquidityMonitor(chainIds: number[]): Promise<void> {
  console.log('Starting liquidity monitor for chains:', chainIds);

  while (true) {
    try {
      const markets = new Map<string, MarketLiquidity>();

      for (const chainId of chainIds) {
        const data = await fetchLiquidityData(chainId);
        for (const market of data) {
          markets.set(market.marketId, market);
        }
      }

      currentSnapshot = {
        timestamp: Date.now(),
        markets,
      };

      console.log(`Liquidity snapshot updated: ${markets.size} markets`);
    } catch (err) {
      console.error('Error updating liquidity snapshot:', err);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
