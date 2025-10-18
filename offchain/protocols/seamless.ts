import { streamCandidates, pollChainCandidatesOnce } from '../indexer/aave_indexer';
import { simulate, PlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter } from './types';

/**
 * Seamless Protocol adapter
 * 
 * Seamless is an Aave v3 fork on Base, so we reuse the same indexer and simulator.
 * The only differences are:
 * - Different contract addresses (configured via seamlessProvider in config.yaml)
 * - Different subgraph (will be handled by indexer options)
 * - Protocol key is 'seamless' for identification
 */
export const seamlessAdapter: ProtocolAdapter = {
  key: 'seamless',
  streamCandidates,
  pollCandidatesOnce: pollChainCandidatesOnce,
  simulate,
  PlanRejectedError,
};

export { PlanRejectedError };
