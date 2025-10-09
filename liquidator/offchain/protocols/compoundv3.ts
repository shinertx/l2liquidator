import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from '../indexer/aave_indexer';
import { PlanRejectedError as AavePlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter, SimulateFn } from './types';

const simulateNotImplemented: SimulateFn = async () => {
  throw new Error('compoundv3-simulate-not-implemented');
};

export const compoundv3Adapter: ProtocolAdapter = {
  key: 'compoundv3',
  async *streamCandidates(_cfg: AppConfig): AsyncIterable<Candidate> {
    // Placeholder: candidates not yet implemented
  },
  async pollCandidatesOnce(_cfg: AppConfig, _chain: ChainCfg): Promise<Candidate[]> {
    return [];
  },
  simulate: simulateNotImplemented,
  PlanRejectedError: AavePlanRejectedError,
};
