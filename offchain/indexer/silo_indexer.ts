import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from './aave_indexer';

// TODO: Replace with real Silo event-driven stream.
export async function* streamSiloCandidates(cfg: AppConfig): AsyncIterable<Candidate> {
  void cfg;
  if (false) {
    yield undefined as unknown as Candidate;
  }
}

// TODO: Replace with Silo-specific polling logic.
export async function pollSiloCandidatesOnce(
  cfg: AppConfig,
  chain: ChainCfg,
  first?: number,
): Promise<Candidate[]> {
  void cfg;
  void chain;
  void first;
  return [];
}
