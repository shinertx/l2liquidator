import type { ProtocolAdapter } from './types';
import { PlanRejectedError } from '../simulator/simulate';
import {
  streamExactlyCandidates,
  pollExactlyCandidatesOnce,
} from '../indexer/exactly_indexer';

export const exactlyAdapter: ProtocolAdapter = {
  key: 'exactly',
  streamCandidates: streamExactlyCandidates,
  pollCandidatesOnce: pollExactlyCandidatesOnce,
  simulate: async () => Promise.resolve(null),
  PlanRejectedError,
};
