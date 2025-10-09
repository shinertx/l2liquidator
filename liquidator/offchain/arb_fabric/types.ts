import type { ChainCfg } from '../infra/config';
import type { QuoteEdge } from '../pipeline/types';
import type { VenueRuntime } from './pair_registry';

export type FabricMode = 'census' | 'active' | 'inventory';

export type VenueKind = 'uniswap_v3';

export type TradeSizeConfig = {
  /**
   * Amount of base token (tokenIn) to spend per attempt, expressed as a decimal string.
   * Example: "0.25" for 0.25 WETH.
   */
  baseAmount: string;
};

export type UniswapV3VenueConfig = {
  id: string;
  label?: string;
  kind: 'uniswap_v3';
  feeBps: number;
  /**
   * Optional override for the Uniswap v3 factory (defaults to canonical factory).
   */
  factory?: `0x${string}`;
  /**
   * Optional override for the quoter contract (defaults to chain config).
   */
  quoter?: `0x${string}`;
  /**
   * Optional sqrt price limit for quoting (0 => no limit).
   */
  sqrtPriceLimitX96?: bigint | number | string;
};

export type VenueConfig = UniswapV3VenueConfig;

export type PairConfig = {
  id: string;
  symbol: string;
  chainId: number;
  baseToken: string;
  quoteToken: string;
  tradeSize: TradeSizeConfig;
  venues: VenueConfig[];
  /**
   * Optional per-pair min net USD threshold (overrides global).
   */
  minNetUsd?: number;
  /**
   * Optional per-pair PNL multiple floor (overrides global).
   */
  pnlMultipleMin?: number;
};

export type FabricChainConfig = {
  chainId: number;
  enabled: boolean;
  /**
   * Symbol of the native gas token according to the chain config (e.g. WETH).
   */
  nativeToken: string;
  treasuryFloatUsd: number;
  /**
   * Estimated gas units for a single-hop bundle on this chain.
   */
  gasUnitsEstimate: number;
  /**
   * Optional safety multiplier to apply on gas estimate (default 1.25).
   */
  gasSafetyMultiplier?: number;
  pairs: PairConfig[];
};

export type FabricGlobalConfig = {
  mode: FabricMode;
  pollIntervalMs: number;
  quoteIntervalMs: number;
  enableSingleHop?: boolean;
  enableTriangular?: boolean;
  enableCrossChain?: boolean;
  /**
   * Minimum net USD to consider an edge profitable.
   */
  minNetUsd: number;
  /**
   * Minimum multiple of gas cost required.
   */
  pnlMultipleMin: number;
  /**
   * Default revert probability estimate (0-1).
   */
  revertProbability: number;
  /**
   * Inclusion latency target in milliseconds (p95).
   */
  inclusionTargetMs: number;
  /**
   * Soft ceiling on outstanding census logs per pair before throttling.
   */
  censusQueueSoftCap?: number;
  /**
   * Maximum edge age before discarding (ms).
   */
  maxEdgeAgeMs?: number;
  /**
   * Desired minimum slippage buffer in basis points when executing.
   */
  slippageBps?: number;
  /**
   * Deadline buffer (seconds) added to current block timestamp for swaps.
   */
  deadlineBufferSec?: number;
  /**
   * Maximum concurrent executions.
   */
  maxConcurrentExecutions?: number;
  /**
   * Maximum venues considered per leg when generating edges.
   */
  maxVenuesPerLeg?: number;
};

export type FabricConfig = {
  global: FabricGlobalConfig;
  chains: FabricChainConfig[];
};

export type PairStateKey = `${number}:${string}`;

export type PoolMidQuote = {
  pairId: string;
  chain: ChainCfg;
  venue: VenueConfig;
  sqrtPriceX96: bigint;
  tick: number;
  liquidity: bigint;
  timestampMs: number;
  token0: `0x${string}`;
  token1: `0x${string}`;
  priceBasePerQuote: number;
  priceQuotePerBase: number;
};

export type VenueQuoteResult = {
  venueId: string;
  baseToQuoteOut: bigint;
  quoteToBaseOut: bigint;
  gasEstimate: bigint;
  sqrtPriceAfterBaseToQuote: bigint;
  sqrtPriceAfterQuoteToBase: bigint;
  timestampMs: number;
};

export type SingleHopEdgeComputation = {
  pair: PairConfig;
  chain: ChainCfg;
  sellVenueId: string;
  sellPoolAddress: `0x${string}`;
  sellLabel?: string;
  buyVenueId: string;
  buyPoolAddress: `0x${string}`;
  buyLabel?: string;
  amountBaseIn: bigint;
  amountQuoteOut: bigint;
  amountBaseReturned: bigint;
  gasWei: bigint;
  gasUsd: number;
  netBase: bigint;
  netUsd: number;
  pnlMultiple: number;
};

export type EdgeConsumer = (edge: QuoteEdge) => Promise<void>;
