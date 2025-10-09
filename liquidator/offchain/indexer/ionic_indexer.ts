import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from './aave_indexer';

// TODO: Implement Ionic candidate streaming.
export async function* streamIonicCandidates(cfg: AppConfig): AsyncIterable<Candidate> {
  void cfg;
  if (false) {
    yield undefined as unknown as Candidate;
  }
}

export async function pollIonicCandidatesOnce(
  cfg: AppConfig,
  chain: ChainCfg,
  first?: number,
): Promise<Candidate[]> {
  void cfg;
  void chain;
  void first;
  return [];
}
