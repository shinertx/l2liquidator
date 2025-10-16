import { streamMorphoBlueCandidates, pollMorphoBlueCandidatesOnce } from '../indexer/morphoblue_indexer';
import { simulate, PlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter } from './types';

export const morphoblueAdapter: ProtocolAdapter = {
  key: 'morphoblue',
  streamCandidates: streamMorphoBlueCandidates,
  pollCandidatesOnce: async (cfg, chain, first) => {
    const { candidates } = await pollMorphoBlueCandidatesOnce(cfg, chain, first);
    return candidates;
  },
  simulate,
  PlanRejectedError,
};