import type { AppConfig, ChainCfg } from '../infra/config';
import { chainById, preliqChainConfig } from '../infra/config';
import type { Address, Hex } from 'viem';
import { encodeAbiParameters, encodeFunctionData, parseAbiItem } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { log } from '../infra/logger';
import type { Candidate } from '../indexer/aave_indexer';
import type { Plan } from '../simulator/simulate';
import { sendPreLiqBundle } from './preliq_sender';

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
  repayAmount: bigint;
  repayShares: bigint;
  seizeAmount: bigint;
  collateralAmount: bigint;
  chainId: number;
  beneficiary: Address;
  profitToken: Address;
};

type SwapQuote = {
  router: Address;
  calldata: Hex;
  amountOut: bigint;
  gasEstimate: bigint;
};

export type BundlerCall = {
  to: Address;
  data: Hex;
  value: bigint;
  skipRevert: boolean;
  callbackHash: Hex;
};

/**
 * Get Bundler3 address for chain
 */
function getBundler3Address(cfg: AppConfig, chainId: number): Address | null {
  const chainCfg = preliqChainConfig(cfg, chainId);
  if (chainCfg?.bundler) return chainCfg.bundler;
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
  bundlerAddress: Address,
  routerOverride: Address | null,
  slippageBps: number
): Promise<SwapQuote | null> {
  try {
    const odosApiKey = process.env.ODOS_API_KEY;
    if (!odosApiKey) {
      return null; // API key required
    }

    const routerAddress = routerOverride ?? ODOS_ROUTER_V2[chainId as keyof typeof ODOS_ROUTER_V2];
    if (!routerAddress) {
      return null;
    }

    const slippagePercent = Math.max(1, slippageBps) / 100;

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
        slippageLimitPercent: slippagePercent,
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
  bundlerAddress: Address,
  routerOverride: Address | null,
  slippageBps: number
): Promise<SwapQuote | null> {
  try {
    const oneinchApiKey = process.env.ONEINCH_API_KEY;
    if (!oneinchApiKey) {
      return null; // API key required
    }

    const fallbackRouter = '0x1111111254EEB25477B68fb85Ed929f73A960582' as Address;
    const oneinchRouter = routerOverride ?? fallbackRouter;

    const url = new URL(`https://api.1inch.dev/swap/v5.2/${chainId}/swap`);
    url.searchParams.set('src', tokenIn);
    url.searchParams.set('dst', tokenOut);
    url.searchParams.set('amount', amountIn.toString());
    url.searchParams.set('from', bundlerAddress);
    url.searchParams.set('slippage', (slippageBps / 100).toString());
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
): Promise<{
  bundler: Address;
  bundle: BundlerCall[];
  calldata: Hex;
  estimatedProfit: bigint;
  gasEstimate: bigint;
  minRepayAssets: bigint;
} | null> {
  const chainPreliq = preliqChainConfig(cfg, params.chainId);
  if (!chainPreliq) {
    log.debug({ chainId: params.chainId }, 'preliq-chain-config-missing');
    return null;
  }

  const bundler3 = getBundler3Address(cfg, params.chainId);
  if (!bundler3) {
    return null;
  }

  const chainCfg = chainById(cfg, params.chainId);
  const wrappedNative = chainCfg?.tokens?.WETH?.address ?? ('0x0000000000000000000000000000000000000000' as Address);

  const odosRouter = chainPreliq.odosRouter ?? ODOS_ROUTER_V2[params.chainId as keyof typeof ODOS_ROUTER_V2] ?? null;
  const oneInchRouter = chainPreliq.oneInchRouter ?? null;
  const slippageBps = cfg.preliq?.aggregator?.slippageBps ?? 50;
  const primary = cfg.preliq?.aggregator?.primary ?? 'odos';

  // Step 1: Get swap quote (Odos primary, 1inch fallback)
  const attemptOdosFirst = primary === 'odos';
  const attemptOneInchFirst = primary === 'oneinch';

  let swapQuote: SwapQuote | null = null;

  const collateralSeized = params.seizeAmount > 0n ? params.seizeAmount : params.collateralAmount;

  const tryOdos = async () => {
    if (!odosRouter) return null;
    return getOdosQuote(
      params.chainId,
      params.collateralAsset,
      params.debtAsset,
      collateralSeized,
      bundler3,
      odosRouter,
      slippageBps
    );
  };

  const tryOneInch = async () =>
    get1inchQuote(
      params.chainId,
      params.collateralAsset,
      params.debtAsset,
      collateralSeized,
      bundler3,
      oneInchRouter,
      slippageBps
    );

  if (attemptOdosFirst) {
    swapQuote = await tryOdos();
    if (!swapQuote) {
      swapQuote = await tryOneInch();
    }
  } else if (attemptOneInchFirst) {
    swapQuote = await tryOneInch();
    if (!swapQuote) {
      swapQuote = await tryOdos();
    }
  } else {
    swapQuote = await tryOdos();
    if (!swapQuote) swapQuote = await tryOneInch();
  }

  if (!swapQuote) {
    console.error('No swap quote available');
    return null;
  }

  // Step 2: Calculate expected profit
  const debtToRepay = params.repayAmount;
  const swapOutput = swapQuote.amountOut;

  // Profit = swap output - debt repaid
  const estimatedProfit = swapOutput - debtToRepay;

  if (estimatedProfit <= 0n) {
    return null; // Not profitable
  }

  const SLIPPAGE_DENOM = 10_000n;
  const boundedSlippage = BigInt(Math.min(Math.max(slippageBps, 0), 10_000));
  const minRepayAssets = debtToRepay * (SLIPPAGE_DENOM - boundedSlippage) / SLIPPAGE_DENOM;

  const callbackData = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'bytes' },
      { type: 'address' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'address' },
    ],
    [
      params.debtAsset,
      minRepayAssets,
      swapQuote.router,
      swapQuote.calldata,
      params.profitToken,
      params.beneficiary,
      params.collateralAsset,
      collateralSeized,
      wrappedNative,
    ]
  );

  const preLiqCall = encodeFunctionData({
    abi: [parseAbiItem('function preLiquidate(address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) external')],
    functionName: 'preLiquidate',
    args: [params.borrower, collateralSeized, params.repayShares, callbackData],
  });

  const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

  const bundle: BundlerCall[] = [
    {
      to: params.offerAddress,
      data: preLiqCall,
      value: 0n,
      skipRevert: false,
      callbackHash: ZERO_BYTES32,
    },
  ];

  const multicallData = encodeFunctionData({
    abi: [
      parseAbiItem(
        'function multicall((address to, bytes data, uint256 value, bool skipRevert, bytes32 callbackHash)[] bundle) external payable returns (bytes[] memory)'
      ),
    ],
    functionName: 'multicall',
    args: [bundle],
  });

  return {
    bundler: bundler3,
    bundle,
    calldata: multicallData,
    estimatedProfit,
    gasEstimate: swapQuote.gasEstimate + 220_000n,
    minRepayAssets,
  };
}

/**
 * Execute pre-liquidation via Bundler3
 */
/**
 * Execute pre-liquidation atomically
 */
type ExecutePreLiqArgs = {
  cfg: AppConfig;
  chain: ChainCfg;
  candidate: Candidate & { preliq: NonNullable<Candidate['preliq']> };
  plan: Plan;
  beneficiary: Address;
  pk: `0x${string}`;
  privateRpc?: string;
};

export async function executePreLiquidation(
  args: ExecutePreLiqArgs
): Promise<{
  success: boolean;
  bundle?: { bundler: Address; bundle: BundlerCall[]; calldata: Hex; estimatedProfit: bigint; gasEstimate: bigint; minRepayAssets: bigint };
  txHash?: Hex;
  error?: string;
}> {
  const { cfg, chain, candidate, plan, beneficiary, pk, privateRpc } = args;

  if (!candidate.preliq) {
    return { success: false, error: 'candidate-missing-preliq' };
  }

  try {
    const params: PreLiqParams = {
      offerAddress: candidate.preliq.offerAddress as Address,
      borrower: candidate.borrower as Address,
      debtAsset: candidate.debt.address,
      collateralAsset: candidate.collateral.address,
      repayAmount: plan.repayAmount,
      repayShares: plan.morpho?.repayShares ?? 0n,
      seizeAmount: plan.seizeAmount,
      collateralAmount: candidate.collateral.amount,
      chainId: chain.id,
      beneficiary,
      profitToken: candidate.debt.address,
    };

    if (params.repayShares === 0n) {
      return { success: false, error: 'missing-repay-shares' };
    }

    const bundle = await buildPreLiqBundle(cfg, params);
    if (!bundle) {
      log.debug({ borrower: candidate.borrower, chainId: chain.id }, 'preliq-bundle-build-failed');
      return { success: false, error: 'bundle-build-failed' };
    }

    log.debug({
      borrower: candidate.borrower,
      chainId: chain.id,
      offer: candidate.preliq.offerAddress,
      estimatedProfit: bundle.estimatedProfit.toString(),
      gasEstimate: bundle.gasEstimate.toString(),
    }, 'preliq-bundle-built');

    const chainPreliq = preliqChainConfig(cfg, chain.id);
    const rpcOverride = chainPreliq?.privateRpc ?? chain.privtx ?? privateRpc;

    const txHash = await sendPreLiqBundle(chain.id, chain.rpc, pk, bundle.bundler, bundle.bundle, rpcOverride);

    return { success: true, bundle, txHash };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
