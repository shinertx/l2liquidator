import type { ProtocolAdapter } from './types';
import { PlanRejectedError } from '../simulator/simulate';
import {
  streamIonicCandidates,
  pollIonicCandidatesOnce,
} from '../indexer/ionic_indexer';

export const ionicAdapter: ProtocolAdapter = {
  key: 'ionic',
  streamCandidates: streamIonicCandidates,
  pollCandidatesOnce: pollIonicCandidatesOnce,
  simulate: async () => Promise.resolve(null),
  PlanRejectedError,
};
