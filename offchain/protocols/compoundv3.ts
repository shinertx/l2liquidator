import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from '../indexer/aave_indexer';
import { streamCompoundV3Candidates, pollCompoundV3CandidatesOnce } from '../indexer/compoundv3_indexer';
import { PlanRejectedError as AavePlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter, SimulateFn } from './types';

const simulateNotImplemented: SimulateFn = async () => {
  throw new Error('compoundv3-simulate-not-implemented');
};

export const compoundv3Adapter: ProtocolAdapter = {
  key: 'compoundv3',
  streamCandidates: streamCompoundV3Candidates,
  pollCandidatesOnce: pollCompoundV3CandidatesOnce,
  simulate: simulateNotImplemented,
  PlanRejectedError: AavePlanRejectedError,
};
