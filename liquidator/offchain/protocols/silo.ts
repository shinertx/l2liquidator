import type { ProtocolAdapter } from './types';
import { PlanRejectedError } from '../simulator/simulate';
import {
  streamSiloCandidates,
  pollSiloCandidatesOnce,
} from '../indexer/silo_indexer';

export const siloAdapter: ProtocolAdapter = {
  key: 'silo',
  streamCandidates: streamSiloCandidates,
  pollCandidatesOnce: pollSiloCandidatesOnce,
  simulate: async () => Promise.resolve(null),
  PlanRejectedError,
};
