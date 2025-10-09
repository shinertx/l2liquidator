import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from '../indexer/aave_indexer';
import { PlanRejectedError as AavePlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter, SimulateFn } from './types';

const simulateNotImplemented: SimulateFn = async () => {
  throw new Error('radiant-simulate-not-implemented');
};

export const radiantAdapter: ProtocolAdapter = {
  key: 'radiant',
  async *streamCandidates(_cfg: AppConfig): AsyncIterable<Candidate> {
    // TODO: implement Radiant candidate stream
  },
  async pollCandidatesOnce(_cfg: AppConfig, _chain: ChainCfg): Promise<Candidate[]> {
    return [];
  },
  simulate: simulateNotImplemented,
  PlanRejectedError: AavePlanRejectedError,
};
