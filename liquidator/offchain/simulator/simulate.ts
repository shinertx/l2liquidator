import type { Address, Chain, PublicClient, Transport } from 'viem';
import { BaseError, ContractFunctionRevertedError, encodeFunctionData } from 'viem';
import { ChainCfg, TokenInfo } from '../infra/config';
import { quoteRoutes, RouteOption, RouteQuote } from './router';
import { encodePlan } from '../executor/build_tx';
import LiquidatorAbi from '../executor/Liquidator.abi.json';

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
};

export type Plan = {
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
  const data = {
    abi: LiquidatorAbi,
    address: contract,
    ...encodePlan(planArgs),
  } as const;

  const calldata = encodeFunctionData({
    abi: LiquidatorAbi,
    functionName: data.functionName,
    args: data.args as any,
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
  const debugReasons: Array<{ stage: string; detail?: unknown }> = SIM_DEBUG ? [] : [];

  if (input.pricesUsd.debt <= 0 || input.pricesUsd.coll <= 0) {
    if (SIM_DEBUG) debugReasons.push({ stage: 'price-invalid', detail: input.pricesUsd });
    if (SIM_DEBUG) console.debug('simulate: abort', debugReasons);
    return null;
  }

  const cfBps = Math.floor(input.closeFactor * 10_000);
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

  const bonusFactor = 1 + input.bonusBps / 10_000;
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

  for (const route of quotes) {
    const planArgs = {
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

    const gasEstimate = await estimateGas(input.client, input.chain, input.contract, input.executor, planArgs);
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
      console.debug('simulate: no-plan', {
        repayUsd,
        minProfit: Number(minProfit) / Math.pow(10, input.debt.decimals),
        floorBps: input.policy.floorBps,
        gasCapUsd: input.gasCapUsd,
        debugReasons,
      });
    }
    return null;
  }

  return {
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
