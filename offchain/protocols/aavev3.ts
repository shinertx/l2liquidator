import { streamCandidates, pollChainCandidatesOnce } from '../indexer/aave_indexer';
import { simulate, PlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter } from './types';

export const aavev3Adapter: ProtocolAdapter = {
  key: 'aavev3',
  streamCandidates,
  pollCandidatesOnce: pollChainCandidatesOnce,
  simulate,
  PlanRejectedError,
};

export { PlanRejectedError };
