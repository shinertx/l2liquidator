import type { AppConfig, ChainCfg, ProtocolKey } from '../infra/config';
import type { Candidate } from '../indexer/aave_indexer';
import type { Plan as SimPlan } from '../simulator/simulate';
import type { simulate } from '../simulator/simulate';
import { PlanRejectedError as AavePlanRejectedError } from '../simulator/simulate';

export type SimulateFn = typeof simulate;

export interface ProtocolAdapter {
  key: ProtocolKey;
  streamCandidates(cfg: AppConfig): AsyncIterable<Candidate>;
  pollCandidatesOnce(cfg: AppConfig, chain: ChainCfg, first?: number): Promise<Candidate[]>;
  simulate: SimulateFn;
  PlanRejectedError: typeof AavePlanRejectedError;
}

export type { Candidate, SimPlan };
