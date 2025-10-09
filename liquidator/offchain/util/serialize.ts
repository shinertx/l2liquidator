import type { Candidate } from '../indexer/aave_indexer';
import type { TokenInfo } from '../infra/config';
import type { Plan as SimPlan } from '../simulator/simulate';
import type { RouteOption } from '../simulator/router';

export type RouteSnapshot = {
  type: RouteOption['type'];
  router: string;
  fee?: number;
  stable?: boolean;
  path?: string;
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
  adaptiveHealthFactorMax?: number;
  adaptiveGapCapBps?: number;
  adaptiveGapVolatility?: number;
  baseHealthFactorMax?: number;
  baseGapCapBps?: number;
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
  gasUsd?: number;
  path?: string;
  executionMode?: string;
  precommit?: boolean;
  netUsd?: number;
  pnlPerGas?: number;
  minProfit: string;
};

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
      case 'UniV3Multi':
        return {
          type: option.type,
          router: option.router,
          path: option.path.join('->'),
          fee: option.fees?.[0],
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
  adaptive?: {
    healthFactorMax: number;
    gapCapBps: number;
    volatility?: number;
    baseHealthFactorMax: number;
    baseGapCapBps: number;
  };
}): CandidateSnapshot {
  const {
    candidate,
    debtToken,
    collateralToken,
    debtPriceUsd,
    collateralPriceUsd,
    gapBps,
    routeOptions,
    adaptive,
  } = input;
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
    adaptiveHealthFactorMax: adaptive?.healthFactorMax ?? adaptive?.baseHealthFactorMax,
    adaptiveGapCapBps: adaptive?.gapCapBps ?? adaptive?.baseGapCapBps,
    adaptiveGapVolatility: adaptive?.volatility,
    baseHealthFactorMax: adaptive?.baseHealthFactorMax,
    baseGapCapBps: adaptive?.baseGapCapBps,
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
    gasUsd: plan.gasUsd,
    path: plan.path,
    executionMode: plan.mode,
    precommit: plan.precommit,
    netUsd: plan.netUsd,
    pnlPerGas: plan.pnlPerGas,
    minProfit: plan.minProfit.toString(),
  };
}

export function serializeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
