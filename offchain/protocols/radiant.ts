import type { AppConfig, ChainCfg } from '../infra/config';
import { streamCandidates as streamAaveCandidates, pollChainCandidatesOnce as pollAaveCandidatesOnce } from '../indexer/aave_indexer';
import { log } from '../infra/logger';
import { simulate, PlanRejectedError } from '../simulator/simulate';
import type { ProtocolAdapter } from './types';

const RADIANT_CHAIN_IDS = [42161];
const MISSING_PLACEHOLDER = '\u0000MISSING:';

function getRadiantSubgraph(): string | undefined {
  const raw = process.env.RADIANT_SUBGRAPH_ARB;
  if (!raw) return undefined;
  if (raw.includes(MISSING_PLACEHOLDER)) return undefined;
  if (raw.trim().length === 0) return undefined;
  return raw.trim();
}

function getOverrides(): Partial<Record<number, string>> {
  const subgraph = getRadiantSubgraph();
  return subgraph ? { 42161: subgraph } : {};
}

export const radiantAdapter: ProtocolAdapter = {
  key: 'radiant',
  async *streamCandidates(cfg: AppConfig) {
    const overrides = getOverrides();
    if (!overrides[42161]) {
      log.warn({ env: 'RADIANT_SUBGRAPH_ARB' }, 'radiant-subgraph-missing');
      return;
    }
    yield* streamAaveCandidates(cfg, {
      protocol: 'radiant',
      subgraphOverrides: overrides,
      chainIds: RADIANT_CHAIN_IDS,
    });
  },
  async pollCandidatesOnce(cfg: AppConfig, chain: ChainCfg, first?: number) {
    if (!RADIANT_CHAIN_IDS.includes(chain.id)) {
      return [];
    }
    const overrides = getOverrides();
    if (!overrides[42161]) {
      log.warn({ env: 'RADIANT_SUBGRAPH_ARB' }, 'radiant-subgraph-missing');
      return [];
    }
    return pollAaveCandidatesOnce(cfg, chain, first, {
      protocol: 'radiant',
      subgraphOverrides: overrides,
      chainIds: RADIANT_CHAIN_IDS,
    });
  },
  simulate,
  PlanRejectedError,
};
