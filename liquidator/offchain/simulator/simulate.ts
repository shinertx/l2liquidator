import type { Address, Chain, PublicClient, Transport } from 'viem';
import { ChainCfg, TokenInfo } from '../infra/config';
import { estimateGasUsd } from './gas';
import { bestRoute, RouteOption } from './router';

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
};

export type Plan = {
  repayAmount: bigint;
  seizeAmount: bigint;
  dexId: number;
  router: Address;
  uniFee: number;
  solidlyStable?: boolean;
  solidlyFactory?: Address;
  amountOutMin: bigint;
  estNetBps: number;
};

function toNumber(amount: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const integer = amount / base;
  const fraction = amount % base;
  return Number(integer) + Number(fraction) / Number(base);
}

function applyBps(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / 10_000n;
}

export async function simulate(input: SimInput): Promise<Plan | null> {
  const cfBps = Math.floor(input.closeFactor * 10_000);
  if (cfBps <= 0) return null;

  const repay = applyBps(input.debt.amount, cfBps);
  if (repay === 0n) return null;

  const repayTokens = toNumber(repay, input.debt.decimals);
  const repayUsd = repayTokens * input.pricesUsd.debt;

  const bonusFactor = 1 + input.bonusBps / 10_000;
  const seizeUsd = repayUsd * bonusFactor;
  if (seizeUsd <= 0) return null;

  const seizeTokens = seizeUsd / input.pricesUsd.coll;
  const seizeAmount = (() => {
    const raw = BigInt(Math.floor(seizeTokens * 10 ** input.collateral.decimals));
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

  const proceedsUsd = toNumber(route.amountOutMin, input.debt.decimals) * input.pricesUsd.debt;
  const GAS_UNITS_HINT = 550_000n;
  const gasUsd = await estimateGasUsd(input.client, input.chain, GAS_UNITS_HINT);
  if (gasUsd > input.gasCapUsd) {
    return null;
  }

  const costsUsd = repayUsd + gasUsd;
  const netUsd = proceedsUsd - costsUsd;
  const estNetBps = repayUsd > 0 ? (netUsd / repayUsd) * 10_000 : 0;

  if (estNetBps < input.policy.floorBps) return null;

  return {
    repayAmount: repay,
    seizeAmount,
    dexId: route.dexId,
    router: route.router,
    uniFee: route.uniFee ?? 0,
    solidlyStable: route.solidlyStable,
    solidlyFactory: route.solidlyFactory,
    amountOutMin: route.amountOutMin,
    estNetBps,
  };
}
