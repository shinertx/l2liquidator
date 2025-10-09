import type { Candidate } from '../indexer/aave_indexer';
import type { SimPlan } from '../protocols/types';
import type { ChainCfg } from '../infra/config';
import type { CandidateSnapshot, PlanSnapshot } from '../util/serialize';

export type CandidateSource = 'watcher' | 'poll' | 'retry';

export type QueuedCandidate = {
  candidate: Candidate;
  chain: ChainCfg;
  source: CandidateSource;
};

export type ScoreMetrics = {
  netUsd: number;
  gasUsd: number;
  pnlPerGas?: number;
  simulateSeconds?: number;
};

export type ScoredPlan = {
  candidate: Candidate;
  chain: ChainCfg;
  plan: SimPlan;
  metrics: ScoreMetrics;
  snapshot: {
    candidate: CandidateSnapshot;
    plan: PlanSnapshot;
  };
  adaptive: {
    healthFactorMax: number;
    gapCapBps: number;
    volatility?: number;
    baseHealthFactorMax: number;
    baseGapCapBps: number;
  };
  gapBps: number;
  debtPriceUsd: number;
  collateralPriceUsd: number;
  nativePriceUsd: number;
};

export type ScoreRejection = {
  candidate: Candidate;
  chain: ChainCfg;
  reason: string;
  detail?: unknown;
  snapshot?: CandidateSnapshot;
  adaptive?: {
    healthFactorMax: number;
    gapCapBps: number;
    volatility?: number;
    baseHealthFactorMax: number;
    baseGapCapBps: number;
  };
  gapBps?: number;
  debtPriceUsd?: number;
  collateralPriceUsd?: number;
  nativePriceUsd?: number;
};

export type TreasuryDecision = {
  mode: 'flash' | 'funds';
  reason?: string;
};

export type ExecutionResult = {
  hash?: `0x${string}`;
  error?: Error;
};

export type EdgeSource = 'single-hop' | 'triangular' | 'cross-chain';

export type EdgeMode = 'census' | 'active' | 'inventory';

export type LegAction = 'flash-loan' | 'flash-swap' | 'swap' | 'bridge' | 'transfer';

export type Leg = {
  chainId: number;
  venue: string;
  poolId?: string;
  action: LegAction;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  minAmountOut?: bigint;
  feeBps?: number;
  metadata?: Record<string, unknown>;
};

export type EdgeRisk = {
  minNetUsd: number;
  pnlMultiple: number;
  revertProbability: number;
  inclusionP95Ms: number;
  mode: EdgeMode;
};

export type QuoteEdge = {
  id: string;
  source: EdgeSource;
  legs: readonly Leg[];
  sizeIn: bigint;
  estNetUsd: number;
  estGasUsd: number;
  estSlippageUsd: number;
  estFailCostUsd: number;
  risk: EdgeRisk;
  createdAtMs: number;
  expiresAtMs?: number;
  tags?: readonly string[];
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type SolverEdgeStream = AsyncGenerator<QuoteEdge, void, unknown>;

export type Solver = {
  findSingleHopEdges(): SolverEdgeStream;
  findTriangularEdges(): SolverEdgeStream;
  findCrossChainEdges(): SolverEdgeStream;
};
