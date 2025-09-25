import type { Candidate } from '../indexer/aave_indexer';
import type { TokenInfo } from '../infra/config';
import type { Plan as SimPlan } from '../simulator/simulate';
import type { RouteOption } from '../simulator/router';

export type RouteSnapshot = {
  type: RouteOption['type'];
  router: string;
  fee?: number;
  stable?: boolean;
};

export type CandidateSnapshot = {
  borrower: `0x${string}`;
  chainId: number;
  debt: {
    symbol: string;
    address: `0x${string}`;
    decimals: number;
    amount: string;
  };
  collateral: {
    symbol: string;
    address: `0x${string}`;
    decimals: number;
    amount: string;
  };
  healthFactor: number;
  debtPriceUsd?: number;
  collateralPriceUsd?: number;
  gapBps?: number;
  routeCandidates?: RouteSnapshot[];
  timestamp: number;
};

export type PlanSnapshot = {
  repayAmount: string;
  seizeAmount: string;
  dexId: number;
  router: string;
  uniFee?: number;
  solidlyStable?: boolean;
  solidlyFactory?: string;
  amountOutMin: string;
  estNetBps: number;
};

function bigIntToString(value: bigint | undefined): string | undefined {
  return typeof value === 'bigint' ? value.toString() : undefined;
}

export function serializeRoutes(options: RouteOption[]): RouteSnapshot[] {
  return options.map((option) => {
    switch (option.type) {
      case 'UniV3':
        return { type: option.type, router: option.router, fee: option.fee };
      case 'SolidlyV2':
        return {
          type: option.type,
          router: option.router,
          fee: option.stable ? 0 : undefined,
          stable: option.stable,
        };
      default:
        return { type: option.type, router: option.router };
    }
  });
}

export function serializeCandidate(input: {
  candidate: Candidate;
  debtToken: TokenInfo;
  collateralToken: TokenInfo;
  debtPriceUsd?: number;
  collateralPriceUsd?: number;
  gapBps?: number;
  routeOptions?: RouteOption[];
}): CandidateSnapshot {
  const { candidate, debtToken, collateralToken, debtPriceUsd, collateralPriceUsd, gapBps, routeOptions } = input;
  return {
    borrower: candidate.borrower,
    chainId: candidate.chainId,
    debt: {
      symbol: candidate.debt.symbol,
      address: candidate.debt.address,
      decimals: debtToken.decimals,
      amount: candidate.debt.amount.toString(),
    },
    collateral: {
      symbol: candidate.collateral.symbol,
      address: candidate.collateral.address,
      decimals: collateralToken.decimals,
      amount: candidate.collateral.amount.toString(),
    },
    healthFactor: (candidate as Candidate).healthFactor,
    debtPriceUsd,
    collateralPriceUsd,
    gapBps,
    routeCandidates: routeOptions ? serializeRoutes(routeOptions) : undefined,
    timestamp: Date.now(),
  };
}

export function serializePlan(plan: SimPlan): PlanSnapshot {
  return {
    repayAmount: plan.repayAmount.toString(),
    seizeAmount: plan.seizeAmount.toString(),
    dexId: plan.dexId,
    router: plan.router,
    uniFee: plan.uniFee,
    solidlyStable: plan.solidlyStable,
    solidlyFactory: plan.solidlyFactory,
    amountOutMin: plan.amountOutMin.toString(),
    estNetBps: plan.estNetBps,
  };
}

export function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
