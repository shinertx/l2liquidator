import type { AppConfig, ChainCfg } from '../infra/config';
import type { Address, Hex } from 'viem';
import { encodeFunctionData, parseAbiItem } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';

// Bundler3 addresses (ChainAgnosticBundlerV2)
const BUNDLER3 = {
  [base.id]: '0x23055618898e202386e6c13955a58D3C68200BFB' as Address,
  [arbitrum.id]: '0x23055618898e202386e6c13955a58D3C68200BFB' as Address,
  [optimism.id]: '0x23055618898e202386e6c13955a58D3C68200BFB' as Address,
} as const;

// Odos Router address
// Odos Router V2 addresses
const ODOS_ROUTER_V2 = {
  [base.id]: '0x19cEeAd7105607Cd444F5ad10dd51356436095a1' as Address,
  [arbitrum.id]: '0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13' as Address,
  [optimism.id]: '0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680' as Address,
} as const;

type PreLiqParams = {
  offerAddress: Address;
  borrower: Address;
  debtAsset: Address;
  collateralAsset: Address;
  debtAmount: bigint;
  collateralAmount: bigint;
  effectiveCloseFactor: number;
  effectiveLiquidationIncentive: number;
  chainId: number;
};

type SwapQuote = {
  router: Address;
  calldata: Hex;
  amountOut: bigint;
  gasEstimate: bigint;
};

/**
 * Get Bundler3 address for chain
 */
function getBundler3Address(chainId: number): Address | null {
  return BUNDLER3[chainId as keyof typeof BUNDLER3] ?? null;
}

/**
 * Get swap quote from Odos
 */
async function getOdosQuote(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  bundlerAddress: Address
): Promise<SwapQuote | null> {
  try {
    const odosApiKey = process.env.ODOS_API_KEY;
    if (!odosApiKey) {
      return null; // API key required
    }

    const routerAddress = ODOS_ROUTER_V2[chainId as keyof typeof ODOS_ROUTER_V2];
    if (!routerAddress) {
      return null;
    }

    const response = await fetch('https://api.odos.xyz/sor/quote/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${odosApiKey}`,
      },
      body: JSON.stringify({
        chainId,
        inputTokens: [{
          tokenAddress: tokenIn,
          amount: amountIn.toString(),
        }],
        outputTokens: [{
          tokenAddress: tokenOut,
          proportion: 1,
        }],
        slippageLimitPercent: 0.5,
        userAddr: bundlerAddress,
        referralCode: 0,
        disableRFQs: false,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // Get swap calldata
    const assembleResponse = await fetch('https://api.odos.xyz/sor/assemble', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${odosApiKey}`,
      },
      body: JSON.stringify({
        pathId: data.pathId,
        userAddr: bundlerAddress,
      }),
    });

    if (!assembleResponse.ok) {
      return null;
    }

    const assembleData = await assembleResponse.json();

    return {
      router: routerAddress,
      calldata: assembleData.transaction.data as Hex,
      amountOut: BigInt(data.outAmounts[0]),
      gasEstimate: BigInt(data.gasEstimate || 200000),
    };
  } catch (err) {
    console.error('Odos quote failed:', err);
    return null;
  }
}

/**
 * Get swap quote from 1inch v5
 */
async function get1inchQuote(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  bundlerAddress: Address
): Promise<SwapQuote | null> {
  try {
    const oneinchApiKey = process.env.ONEINCH_API_KEY;
    if (!oneinchApiKey) {
      return null; // API key required
    }

    const oneinchRouter = '0x1111111254EEB25477B68fb85Ed929f73A960582' as Address;

    const url = new URL(`https://api.1inch.dev/swap/v5.2/${chainId}/swap`);
    url.searchParams.set('src', tokenIn);
    url.searchParams.set('dst', tokenOut);
    url.searchParams.set('amount', amountIn.toString());
    url.searchParams.set('from', bundlerAddress);
    url.searchParams.set('slippage', '0.5');
    url.searchParams.set('disableEstimate', 'false');
    url.searchParams.set('allowPartialFill', 'false');

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${oneinchApiKey}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    return {
      router: oneinchRouter,
      calldata: data.tx.data as Hex,
      amountOut: BigInt(data.toAmount),
      gasEstimate: BigInt(data.tx.gas || 250000),
    };
  } catch (err) {
    console.error('1inch quote failed:', err);
    return null;
  }
}

/**
 * Build Bundler3 multicall payload for pre-liquidation
 */
export async function buildPreLiqBundle(
  cfg: AppConfig,
  params: PreLiqParams
): Promise<{ calldata: Hex; estimatedProfit: bigint; gasEstimate: bigint } | null> {
  const bundler3 = getBundler3Address(params.chainId);
  if (!bundler3) {
    return null;
  }

  // Step 1: Get swap quote (Odos primary, 1inch fallback)
  let swapQuote = await getOdosQuote(
    params.chainId,
    params.collateralAsset,
    params.debtAsset,
    params.collateralAmount,
    bundler3
  );

  if (!swapQuote) {
    swapQuote = await get1inchQuote(
      params.chainId,
      params.collateralAsset,
      params.debtAsset,
      params.collateralAmount,
      bundler3
    );
  }

  if (!swapQuote) {
    console.error('No swap quote available');
    return null;
  }

  // Step 2: Calculate expected profit
  const debtToRepay = BigInt(Math.floor(Number(params.debtAmount) * params.effectiveCloseFactor));
  const collateralSeized = params.collateralAmount;
  const swapOutput = swapQuote.amountOut;

  // Profit = swap output - debt repaid
  const estimatedProfit = swapOutput - debtToRepay;

  if (estimatedProfit <= 0n) {
    return null; // Not profitable
  }

  // Step 3: Build Bundler3 multicall
  const calls: Hex[] = [];

  // Call 1: onPreLiquidate(offer, borrower, seizeParams)
  const preLiqCalldata = encodeFunctionData({
    abi: [
      parseAbiItem(
        'function onPreLiquidate(address offer, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) external'
      ),
    ],
    functionName: 'onPreLiquidate',
    args: [params.offerAddress, params.borrower, collateralSeized, debtToRepay, '0x' as Hex],
  });
  calls.push(preLiqCalldata);

  // Call 2: Swap collateral → debt via aggregator
  calls.push(swapQuote.calldata);

  // Call 3: Repay debt to Morpho
  // TODO: Build repayment calldata

  // Call 4: Transfer profit to beneficiary
  // TODO: Build transfer calldata

  // Step 4: Encode final multicall
  const multicallData = encodeFunctionData({
    abi: [parseAbiItem('function multicall(bytes[] calldata data) external returns (bytes[] memory)')],
    functionName: 'multicall',
    args: [calls],
  });

  return {
    calldata: multicallData,
    estimatedProfit,
    gasEstimate: swapQuote.gasEstimate + 200_000n, // Add overhead for pre-liq + repay
  };
}

/**
 * Execute pre-liquidation via Bundler3
 */
/**
 * Execute pre-liquidation atomically
 */
export async function executePreLiquidation(
  candidate: any,
  cfg: AppConfig
): Promise<{ success: boolean; txHash?: Hex; error?: string }> {
  try {
    // Extract parameters from candidate
    const params: PreLiqParams = {
      offerAddress: candidate.preliq.offerAddress,
      borrower: candidate.borrower as Address,
      debtAsset: candidate.debtAsset as Address,
      collateralAsset: candidate.collateralAsset as Address,
      debtAmount: BigInt(candidate.debtAmount || 0),
      collateralAmount: BigInt(candidate.collateralAmount || 0),
      effectiveCloseFactor: candidate.preliq.effectiveCloseFactor,
      effectiveLiquidationIncentive: candidate.preliq.effectiveLiquidationIncentive,
      chainId: candidate.chainId,
    };

    // Build the bundle
    const bundle = await buildPreLiqBundle(cfg, params);
    if (!bundle) {
      return { success: false, error: 'Failed to build bundle (no profitable swap route)' };
    }

    // TODO: Implement transaction submission
    // - Get nonce from nonce manager
    // - Build transaction with appropriate gas settings
    // - For Arbitrum: Submit via Timeboost with sealed bid
    // - For Base/Optimism: Submit via private RPC
    // - Wait for confirmation
    // - Log metrics

    return { success: false, error: 'Transaction submission not implemented yet' };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
