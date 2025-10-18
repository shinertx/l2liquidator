import type { Address, Chain, PublicClient, Transport } from 'viem';
import { BaseError, ContractFunctionRevertedError, encodeFunctionData } from 'viem';
import { ChainCfg, ProtocolKey, TokenInfo } from '../infra/config';
import { quoteRoutes, RouteOption, RouteQuote } from './router';
import { encodePlan } from '../executor/build_tx';

type RpcClient = PublicClient<Transport, Chain | undefined, any>;

export type TokenPosition = TokenInfo & { symbol: string; amount: bigint };

export type SimInput = {
  client: RpcClient;
  chain: ChainCfg;
  debt: TokenPosition;
  collateral: TokenPosition;
  closeFactor: number; // 0..1
  bonusBps: number; // liquidation bonus e.g. 800
  routes: RouteOption[];
  pricesUsd: { debt: number; coll: number };
  policy: { floorBps: number; gapCapBps: number; slippageBps: number };
  gasCapUsd: number;
  maxRepayUsd?: number;
  nativePriceUsd: number;
  contract: Address;
  beneficiary: Address;
  executor: Address;
  borrower: Address;
  protocol?: ProtocolKey;
  morpho?: {
    borrowShares: bigint;
    market: {
      loanToken: Address;
      collateralToken: Address;
      oracle: Address;
      irm: Address;
      lltv: bigint;
    };
    callbackData?: `0x${string}`;
  };
  // Pre-liquidation offer (if available)
  preliq?: {
    offerAddress: Address;
    effectiveCloseFactor: number;
    effectiveLiquidationIncentive: number;
    oracleAddress: Address;
    expiry: bigint;
  };
};

export type Plan = {
  protocol: ProtocolKey;
  repayAmount: bigint;
  seizeAmount: bigint;
  repayUsd: number;
  dexId: number;
  router: Address;
  uniFee: number;
  solidlyStable?: boolean;
  solidlyFactory?: Address;
  amountOutMin: bigint;
  estNetBps: number;
  gasUsd: number;
  path: `0x${string}`;
  mode?: 'flash' | 'funds';
  precommit?: boolean;
  netUsd: number;
  pnlPerGas?: number;
  minProfit: bigint;
  morpho?: {
    market: {
      loanToken: Address;
      collateralToken: Address;
      oracle: Address;
      irm: Address;
      lltv: bigint;
    };
    repayShares: bigint;
    callbackData: `0x${string}`;
  };
  // Pre-liquidation execution details (if using Bundler3 path)
  preliq?: {
    offerAddress: Address;
    useBundler: boolean; // true = Bundler3, false = standard flash loan
  };
};

const HEALTH_FACTOR_ERROR = 'HealthFactorNotBelowThreshold';
const HEALTH_FACTOR_SELECTOR = '0x930bb771';
const OP_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';

type PlanRejectReason = 'contract_revert';

export class PlanRejectedError extends Error {
  constructor(
    public readonly code: PlanRejectReason,
    message: string,
    public readonly detail?: { data?: unknown; signature?: string; shortMessage?: string }
  ) {
    super(message);
    this.name = 'PlanRejectedError';
  }
}
const GAS_PRICE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getL1Fee',
    stateMutability: 'view',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ARB_GAS_INFO = '0x000000000000000000000000000000000000006C';
const ARB_GAS_INFO_ABI = [
  {
    type: 'function',
    name: 'gasEstimateL1Component',
    stateMutability: 'view',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'contractCreation', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

function toNumber(amount: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const integer = amount / base;
  const fraction = amount % base;
  return Number(integer) + Number(fraction) / Number(base);
}

function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

type EncodedPlanArgs = Parameters<typeof encodePlan>[0];

const BPS_DENOMINATOR = 10_000n;

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new Error('division by zero');
  }
  if (numerator === 0n) {
    return 0n;
  }
  return (numerator + (denominator - 1n)) / denominator;
}

function isHealthFactorError(err: ContractFunctionRevertedError | null): boolean {
  if (!err) return false;
  const errorName = err.data?.errorName ?? (err as any).errorName;
  if (errorName === HEALTH_FACTOR_ERROR) {
    return true;
  }

  const signature =
    (err.data as any)?.errorSignature ??
    (err.data as any)?.signature ??
    (err as any).signature ??
    (err as any).data?.slice?.(0, 10);
  if (signature === HEALTH_FACTOR_SELECTOR) {
    return true;
  }

  const raw = (err.data as any)?.data ?? (err as any).data;
  return typeof raw === 'string' && raw.startsWith(HEALTH_FACTOR_SELECTOR);
}

async function estimateGas(
  client: RpcClient,
  chain: ChainCfg,
  contract: Address,
  executor: Address,
  planArgs: EncodedPlanArgs,
): Promise<{ totalEth: number; gasEth: number; l1Eth: number } | null> {
  const encoded = encodePlan(planArgs);
  const data = {
    ...encoded,
    address: contract,
  } as const;

  const calldata = encodeFunctionData({
    abi: encoded.abi,
    functionName: encoded.functionName,
    args: encoded.args as any,
  });

  let gas: bigint;
  try {
    gas = await client.estimateContractGas({ account: executor, ...data });
  } catch (err) {
    if (err instanceof BaseError) {
      const revert = err.walk((error) => error instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        if (isHealthFactorError(revert)) {
          return null;
        }
        const shortMessage = (revert as any).shortMessage ?? revert.message;
        throw new PlanRejectedError('contract_revert', shortMessage, {
          data: (revert as any).data,
          signature: (revert as any).signature,
          shortMessage,
        });
      }
    }
    throw err;
  }

  const fees = await client.estimateFeesPerGas();
  const maxFeePerGas = (fees as any).maxFeePerGas as bigint | undefined;
  const gasPrice = (fees as any).gasPrice as bigint | undefined;
  let weiPerGas: bigint;
  if (maxFeePerGas && maxFeePerGas > 0n) {
    weiPerGas = maxFeePerGas;
  } else if (gasPrice && gasPrice > 0n) {
    weiPerGas = gasPrice;
  } else {
    weiPerGas = await client.getGasPrice();
  }

  const gasEth = (Number(weiPerGas) / 1e18) * Number(gas);
  let l1FeeEth = 0;
  try {
    const l1FeeWei = await estimateL1Fee(client, chain.id, executor, calldata);
    l1FeeEth = Number(l1FeeWei) / 1e18;
  } catch {
    // ignore oracle failure; fallback to base gas cost
  }

  return { totalEth: gasEth + l1FeeEth, gasEth, l1Eth: l1FeeEth };
}

const SIM_DEBUG = process.env.SIM_DEBUG === '1';

export async function simulate(input: SimInput): Promise<Plan | null> {
  type DebugReason = { stage: string; detail?: unknown } & Record<string, unknown>;
  const debugReasons: DebugReason[] = SIM_DEBUG ? [] : [];
  const protocolKey: ProtocolKey = input.protocol ?? (input.morpho ? 'morphoblue' : 'aavev3');

  // Pre-liquidation scoring: If candidate has preliq offer, validate and potentially use Bundler3
  let usePreliq = false;
  let preliqCloseFactor = input.closeFactor;
  let preliqBonusBps = input.bonusBps;

  if (input.preliq && protocolKey === 'morphoblue') {
    const { preliq } = input;
    const now = BigInt(Math.floor(Date.now() / 1000));

    // Validation 1: Check expiry
    if (preliq.expiry <= now) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'preliq-expired', expiry: preliq.expiry.toString(), now: now.toString() });
    }
    // Validation 2: Check minimum incentive (150 bps = 1.5%)
    else if (preliq.effectiveLiquidationIncentive < 0.015) {
      if (SIM_DEBUG) debugReasons.push({ 
        stage: 'preliq-incentive-low', 
        incentive: preliq.effectiveLiquidationIncentive 
      });
    }
    // Validation 3: Check effective close factor is reasonable
    else if (preliq.effectiveCloseFactor <= 0 || preliq.effectiveCloseFactor > 1) {
      if (SIM_DEBUG) debugReasons.push({ 
        stage: 'preliq-cf-invalid', 
        closeFactor: preliq.effectiveCloseFactor 
      });
    }
    // All validations passed - use pre-liq parameters
    else {
      usePreliq = true;
      preliqCloseFactor = preliq.effectiveCloseFactor;
      preliqBonusBps = Math.floor(preliq.effectiveLiquidationIncentive * 10_000);
      if (SIM_DEBUG) debugReasons.push({ 
        stage: 'preliq-accepted', 
        offer: preliq.offerAddress,
        cf: preliqCloseFactor,
        bonusBps: preliqBonusBps
      });
    }
  }

  // Use pre-liq parameters if available, otherwise use standard
  const closeFactor = usePreliq ? preliqCloseFactor : input.closeFactor;
  const bonusBps = usePreliq ? preliqBonusBps : input.bonusBps;

  if (input.pricesUsd.debt <= 0 || input.pricesUsd.coll <= 0) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'price-invalid', detail: input.pricesUsd });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  const cfBps = Math.floor(closeFactor * 10_000);
  if (cfBps <= 0) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'close-factor-nonpositive', detail: cfBps });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  let repay = applyBps(input.debt.amount, cfBps);
  if (repay === 0n) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'repay-zero' });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  const pow10 = Math.pow(10, input.debt.decimals);
  if (!Number.isFinite(pow10) || pow10 <= 0) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'pow10-invalid', detail: pow10 });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  const toTokensNumber = (amount: bigint) => toNumber(amount, input.debt.decimals);
  let repayTokens = toTokensNumber(repay);
  let repayUsd = repayTokens * input.pricesUsd.debt;

  if (input.maxRepayUsd !== undefined && input.maxRepayUsd > 0 && repayUsd > input.maxRepayUsd) {
    const maxRepayTokens = input.maxRepayUsd / input.pricesUsd.debt;
    if (!Number.isFinite(maxRepayTokens) || maxRepayTokens <= 0) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'max-repay-invalid', detail: maxRepayTokens });
      if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
      return null;
    }
    const maxRepayAmount = BigInt(Math.floor(maxRepayTokens * pow10));
    if (maxRepayAmount <= 0n) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'max-repay-amount-nonpositive', detail: maxRepayAmount });
      if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
      return null;
    }
    repay = maxRepayAmount < repay ? maxRepayAmount : repay;
    repayTokens = toTokensNumber(repay);
    repayUsd = repayTokens * input.pricesUsd.debt;
    if (repay <= 0n || repayUsd <= 0) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'repay-after-cap-nonpositive', detail: { repay, repayUsd } });
      if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
      return null;
    }
  }

  const bonusFactor = 1 + bonusBps / 10_000;
  const seizeUsd = repayUsd * bonusFactor;
  if (seizeUsd <= 0) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'seize-usd-nonpositive', detail: seizeUsd });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  const seizeTokens = seizeUsd / input.pricesUsd.coll;
  const seizeAmount = (() => {
    const seizePow = Math.pow(10, input.collateral.decimals);
    if (!Number.isFinite(seizePow) || seizePow <= 0) return 0n;
    const raw = BigInt(Math.floor(seizeTokens * seizePow));
    return raw > input.collateral.amount ? input.collateral.amount : raw;
  })();
  if (seizeAmount === 0n) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'seize-amount-zero' });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  const floorBps = BigInt(input.policy.floorBps);
  const minProfit = floorBps > 0n ? ceilDiv(repay * floorBps, BPS_DENOMINATOR) : 0n;
  if (minProfit === 0n) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'min-profit-zero', detail: { repay, floorBps } });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const nativePrice = input.nativePriceUsd > 0 ? input.nativePriceUsd : input.pricesUsd.debt;
  const quotes = await quoteRoutes({
    client: input.client,
    chain: input.chain,
    contract: input.contract,
    collateral: input.collateral,
    debt: input.debt,
    seizeAmount,
    slippageBps: input.policy.slippageBps,
    options: input.routes,
  });

  if (quotes.length === 0) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'no-quotes' });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  let best: { route: RouteQuote; gasUsd: number; netUsd: number; estNetBps: number } | null = null;
  let morphoPlan: Plan['morpho'] | undefined;

  if (protocolKey === 'morphoblue') {
    const morpho = input.morpho;
    if (!morpho) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'morpho-metadata-missing' });
      if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
      return null;
    }
    if (morpho.borrowShares <= 0n || input.debt.amount <= 0n) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'morpho-borrowshares-zero', detail: { borrowShares: morpho.borrowShares, debt: input.debt.amount } });
      if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
      return null;
    }
    let repayShares = ceilDiv(repay * morpho.borrowShares, input.debt.amount);
    if (repayShares === 0n) {
      if (SIM_DEBUG)
        debugReasons.push({ stage: 'morpho-repayshares-zero', detail: { repay, borrowShares: morpho.borrowShares, debt: input.debt.amount } });
      if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
      return null;
    }
    if (repayShares > morpho.borrowShares) {
      repayShares = morpho.borrowShares;
    }
    morphoPlan = {
      market: morpho.market,
      repayShares,
      callbackData: morpho.callbackData ?? ('0x' as `0x${string}`),
    };
  }

  for (const route of quotes) {
    let planArgs: EncodedPlanArgs;
    if (protocolKey === 'morphoblue') {
      if (!morphoPlan) {
        if (SIM_DEBUG) debugReasons.push({ stage: 'morpho-plan-missing' });
        return null;
      }
      planArgs = {
        protocol: 'morphoblue',
        borrower: input.borrower,
        repayAmount: repay,
        dexId: route.dexId,
        router: route.router,
        uniFee: route.uniFee ?? 0,
        solidlyStable: route.solidlyStable,
        solidlyFactory: route.solidlyFactory,
        minProfit,
        amountOutMin: route.amountOutMin,
        deadline,
        path: route.path ?? '0x',
        market: morphoPlan.market,
        repayShares: morphoPlan.repayShares,
        callbackData: morphoPlan.callbackData,
      } satisfies EncodedPlanArgs;
    } else {
      planArgs = {
        protocol: protocolKey,
        borrower: input.borrower,
        debtAsset: input.debt.address,
        collateralAsset: input.collateral.address,
        repayAmount: repay,
        dexId: route.dexId,
        router: route.router,
        uniFee: route.uniFee ?? 0,
        solidlyStable: route.solidlyStable,
        solidlyFactory: route.solidlyFactory,
        minProfit,
        amountOutMin: route.amountOutMin,
        deadline,
        path: route.path ?? '0x',
      } satisfies EncodedPlanArgs;
    }

    let gasEstimate: { totalEth: number; gasEth: number; l1Eth: number } | null;
    try {
      gasEstimate = await estimateGas(input.client, input.chain, input.contract, input.executor, planArgs);
    } catch (err) {
      if (err instanceof PlanRejectedError) {
        if (SIM_DEBUG)
          debugReasons.push({
            stage: 'estimate-gas-reject',
            detail: err.detail ?? { message: err.message, code: err.code },
            route: {
              dexId: route.dexId,
              router: route.router,
              uniFee: route.uniFee,
              solidlyStable: route.solidlyStable,
              solidlyFactory: route.solidlyFactory,
            },
            repay: repay.toString(),
            amountOutMin: route.amountOutMin.toString(),
            minProfit: minProfit.toString(),
          });
        continue;
      }
      throw err;
    }
    if (!gasEstimate) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'estimate-gas-null', detail: { dexId: route.dexId } });
      continue;
    }

    const gasUsd = gasEstimate.totalEth * nativePrice;
    if (gasUsd > input.gasCapUsd) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'gas-cap', detail: { gasUsd, gasCap: input.gasCapUsd } });
      continue;
    }

    const proceedsUsd = toNumber(route.amountOutMin, input.debt.decimals) * input.pricesUsd.debt;
    const costsUsd = repayUsd + gasUsd;
    const netUsd = proceedsUsd - costsUsd;
    const estNetBps = repayUsd > 0 ? (netUsd / repayUsd) * 10_000 : 0;
    if (estNetBps < input.policy.floorBps) {
      if (SIM_DEBUG) debugReasons.push({ stage: 'floor-bps', detail: { estNetBps, floorBps: input.policy.floorBps } });
      continue;
    }

    if (!best || netUsd > best.netUsd) {
      best = { route, gasUsd, netUsd, estNetBps };
    }
  }

  if (!best) {
    if (SIM_DEBUG) {
      console.debug(
        'simulate: no-plan',
        JSON.stringify(
          {
            repayUsd,
            minProfit: Number(minProfit) / Math.pow(10, input.debt.decimals),
            floorBps: input.policy.floorBps,
            gasCapUsd: input.gasCapUsd,
            debugReasons,
          },
          null,
          2,
        ),
      );
    }
    return null;
  }

  return {
    protocol: protocolKey,
    repayAmount: repay,
    seizeAmount,
    repayUsd,
    dexId: best.route.dexId,
    router: best.route.router,
    uniFee: best.route.uniFee ?? 0,
    solidlyStable: best.route.solidlyStable,
    solidlyFactory: best.route.solidlyFactory,
    amountOutMin: best.route.amountOutMin,
    estNetBps: best.estNetBps,
    gasUsd: best.gasUsd,
    path: best.route.path ?? '0x',
    netUsd: best.netUsd,
    minProfit,
    morpho: morphoPlan,
    preliq: usePreliq && input.preliq ? {
      offerAddress: input.preliq.offerAddress,
      useBundler: true,
    } : undefined,
  };
}

async function estimateL1Fee(
  client: RpcClient,
  chainId: number,
  sender: Address,
  calldata: `0x${string}`,
): Promise<bigint> {
  if (chainId === 10 || chainId === 8453) {
    return (await client.readContract({
      address: OP_GAS_PRICE_ORACLE,
      abi: GAS_PRICE_ORACLE_ABI,
      functionName: 'getL1Fee',
      args: [calldata],
    })) as bigint;
  }

  if (chainId === 42161) {
    try {
      return (await client.readContract({
        address: ARB_GAS_INFO,
        abi: ARB_GAS_INFO_ABI,
        functionName: 'gasEstimateL1Component',
        args: [sender, calldata, false],
      })) as bigint;
    } catch {
      return 0n;
    }
  }

  return 0n;
}
