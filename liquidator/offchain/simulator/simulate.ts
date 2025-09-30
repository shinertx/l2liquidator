import type { Address, Chain, PublicClient, Transport } from 'viem';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { ChainCfg, TokenInfo } from '../infra/config';
import { bestRoute, RouteOption } from './router';
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
};

const HEALTH_FACTOR_ERROR = 'HealthFactorNotBelowThreshold';
const HEALTH_FACTOR_SELECTOR = '0x930bb771';

function toNumber(amount: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const integer = amount / base;
  const fraction = amount % base;
  return Number(integer) + Number(fraction) / Number(base);
}

function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

async function estimateGas(
  client: RpcClient,
  chain: ChainCfg,
  contract: Address,
  executor: Address,
  plan: any
): Promise<number | null> {
  const data = {
    abi: LiquidatorAbi,
    address: contract,
    ...encodePlan(plan),
  } as const;

  let gas: bigint;
  try {
    gas = await client.estimateContractGas({ account: executor, ...data });
  } catch (err) {
    if (err instanceof BaseError) {
      const revert = err.walk((error) => error instanceof ContractFunctionRevertedError);
      if (revert instanceof ContractFunctionRevertedError) {
        const errorName = revert.data?.errorName ?? (revert as any).errorName;
        if (errorName === HEALTH_FACTOR_ERROR) {
          return null;
        }
        const signature =
          (revert.data as any)?.errorSignature ??
          (revert.data as any)?.signature ??
          (revert as any).signature;
        if (signature === HEALTH_FACTOR_SELECTOR) {
          return null;
        }
        const raw = (revert.data as any)?.data ?? (revert as any).data;
        if (typeof raw === 'string' && raw.startsWith(HEALTH_FACTOR_SELECTOR)) {
          return null;
        }
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

  const gasEth = Number(weiPerGas) / 1e18 * Number(gas);
  return gasEth;
}

export async function simulate(input: SimInput): Promise<Plan | null> {
  if (input.pricesUsd.debt <= 0 || input.pricesUsd.coll <= 0) {
    return null;
  }

  const cfBps = Math.floor(input.closeFactor * 10_000);
  if (cfBps <= 0) return null;

  let repay = applyBps(input.debt.amount, cfBps);
  if (repay === 0n) return null;

  const pow10 = Math.pow(10, input.debt.decimals);
  if (!Number.isFinite(pow10) || pow10 <= 0) return null;

  const toTokensNumber = (amount: bigint) => toNumber(amount, input.debt.decimals);
  let repayTokens = toTokensNumber(repay);
  let repayUsd = repayTokens * input.pricesUsd.debt;

  if (input.maxRepayUsd !== undefined && input.maxRepayUsd > 0 && repayUsd > input.maxRepayUsd) {
    const maxRepayTokens = input.maxRepayUsd / input.pricesUsd.debt;
    if (!Number.isFinite(maxRepayTokens) || maxRepayTokens <= 0) return null;
    const maxRepayAmount = BigInt(Math.floor(maxRepayTokens * pow10));
    if (maxRepayAmount <= 0n) return null;
    repay = maxRepayAmount < repay ? maxRepayAmount : repay;
    repayTokens = toTokensNumber(repay);
    repayUsd = repayTokens * input.pricesUsd.debt;
    if (repay <= 0n || repayUsd <= 0) return null;
  }

  const bonusFactor = 1 + input.bonusBps / 10_000;
  const seizeUsd = repayUsd * bonusFactor;
  if (seizeUsd <= 0) return null;

  const seizeTokens = seizeUsd / input.pricesUsd.coll;
  const seizeAmount = (() => {
    const seizePow = Math.pow(10, input.collateral.decimals);
    if (!Number.isFinite(seizePow) || seizePow <= 0) return 0n;
    const raw = BigInt(Math.floor(seizeTokens * seizePow));
    return raw > input.collateral.amount ? input.collateral.amount : raw;
  })();
  if (seizeAmount === 0n) return null;

  const route = await bestRoute({
    client: input.client,
    chain: input.chain,
    collateral: input.collateral,
    debt: input.debt,
    seizeAmount,
    slippageBps: input.policy.slippageBps,
    options: input.routes,
  });

  if (!route) return null;

  const minProfit = (repay * BigInt(input.policy.floorBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const gasEth = await estimateGas(input.client, input.chain, input.contract, input.executor, {
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
  });

  if (gasEth === null) {
    return null;
  }

  const gasUsd = gasEth * input.pricesUsd.debt; // Assuming debt is a stablecoin
  if (gasUsd > input.gasCapUsd) {
    return null;
  }

  const proceedsUsd = toNumber(route.amountOutMin, input.debt.decimals) * input.pricesUsd.debt;
  const costsUsd = repayUsd + gasUsd;
  const netUsd = proceedsUsd - costsUsd;
  const estNetBps = repayUsd > 0 ? (netUsd / repayUsd) * 10_000 : 0;

  if (estNetBps < input.policy.floorBps) return null;

  return {
    repayAmount: repay,
    seizeAmount,
    repayUsd,
    dexId: route.dexId,
    router: route.router,
    uniFee: route.uniFee ?? 0,
    solidlyStable: route.solidlyStable,
    solidlyFactory: route.solidlyFactory,
    amountOutMin: route.amountOutMin,
    estNetBps,
  };
}
