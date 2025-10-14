import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from '../indexer/aave_indexer';
import { simulate, PlanRejectedError as AavePlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter } from './types';
import { streamMorphoBlueCandidates, pollMorphoBlueCandidatesOnce } from '../indexer/morphoblue_indexer';

const STREAM_ENABLED = process.env.MORPHO_BLUE_STREAM_ENABLED === '1';

export const morphoBlueAdapter: ProtocolAdapter = {
  key: 'morphoblue',
  async *streamCandidates(cfg: AppConfig): AsyncIterable<Candidate> {
    if (!STREAM_ENABLED) return;
    yield* streamMorphoBlueCandidates(cfg);
  },
  async pollCandidatesOnce(cfg: AppConfig, chain: ChainCfg): Promise<Candidate[]> {
    const { candidates } = await pollMorphoBlueCandidatesOnce(cfg, chain);
    return candidates;
  },
  simulate,
  PlanRejectedError: AavePlanRejectedError,
};
