import type { AppConfig, ChainCfg } from '../infra/config';
import type { Candidate } from './aave_indexer';

const DEFAULT_ENDPOINT =
  process.env.MORPHO_BLUE_GRAPHQL_ENDPOINT?.trim() ??
  'https://blue-api.morpho.org/graphql';
const DEFAULT_MAX_COMPLEXITY = Number(process.env.MORPHO_BLUE_MAX_COMPLEXITY ?? 1000);
const DEFAULT_LIMIT = Number(process.env.MORPHO_BLUE_FIRST ?? 500);
const DEFAULT_HF_THRESHOLD = Number(process.env.MORPHO_BLUE_HF_THRESHOLD ?? 1.05);
const BASE_POLL_DELAY_MS = Number(process.env.MORPHO_BLUE_POLL_DELAY_MS ?? 5_000);
const MIN_POLL_DELAY_MS = Math.max(1_000, Number(process.env.MORPHO_BLUE_MIN_POLL_DELAY_MS ?? 5_000));
const MAX_POLL_DELAY_MS = Math.max(MIN_POLL_DELAY_MS, Number(process.env.MORPHO_BLUE_MAX_POLL_DELAY_MS ?? BASE_POLL_DELAY_MS));
const BACKOFF_MULTIPLIER = Math.max(1, Number(process.env.MORPHO_BLUE_BACKOFF_MULTIPLIER ?? 2));
const SUCCESS_DELAY_MS = Math.max(MIN_POLL_DELAY_MS, Number(process.env.MORPHO_BLUE_SUCCESS_DELAY_MS ?? MIN_POLL_DELAY_MS));
const WAIT_FLOOR_MS = Math.max(50, Number(process.env.MORPHO_BLUE_WAIT_FLOOR_MS ?? 100));
const parsedChainIds = (process.env.MORPHO_BLUE_CHAIN_IDS ?? '1')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const SUPPORTED_CHAIN_IDS = parsedChainIds.length > 0 ? parsedChainIds : [1];

function isSupportedChain(chainId: number): boolean {
  return SUPPORTED_CHAIN_IDS.includes(chainId);
}

type MorphoMarketPosition = {
  id: string;
  healthFactor: number;
  user: { address: string };
  market: {
    uniqueKey: string;
    loanAsset: { symbol: string; decimals: number; address: `0x${string}` };
    collateralAsset: { symbol?: string | null; decimals?: number | null; address?: `0x${string}` | null };
    irmAddress?: `0x${string}` | null;
    oracleAddress?: `0x${string}` | null;
    lltv?: string | null;
  };
  state: {
    borrowAssets: string;
    collateral: string | null;
    borrowShares?: string | null;
  };
};

type MorphoResponse = {
  data?: {
    marketPositions?: {
      items?: MorphoMarketPosition[];
    };
  };
  errors?: Array<{ message: string }>;
  extensions?: { complexity?: number };
};

function parseBigInt(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCandidate(chain: ChainCfg, position: MorphoMarketPosition): Candidate | null {
  const debtDecimals = Number.isFinite(position.market.loanAsset.decimals)
    ? position.market.loanAsset.decimals
    : 18;

  const collateralDecimals = Number.isFinite(position.market.collateralAsset?.decimals ?? 0)
    ? Number(position.market.collateralAsset?.decimals ?? 18)
    : 18;

  const healthFactor = Number(position.healthFactor);
  if (!Number.isFinite(healthFactor) || healthFactor <= 0) {
    return null;
  }

  const debtAmount = parseBigInt(position.state.borrowAssets);
  if (debtAmount === 0n) {
    return null;
  }

  const collateralAmount = parseBigInt(position.state.collateral);
  const borrowShares = parseBigInt(position.state.borrowShares);

  const debtAddress = (position.market.loanAsset.address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
  const collateralAddress =
    (position.market.collateralAsset?.address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;

  const irmAddress = (position.market.irmAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
  const oracleAddress = (position.market.oracleAddress ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
  const lltv = parseBigInt(position.market.lltv);

  return {
    borrower: (position.user.address ?? '0x').toLowerCase() as `0x${string}`,
    chainId: chain.id,
    debt: {
      symbol: position.market.loanAsset.symbol ?? 'UNKNOWN',
      address: debtAddress,
      decimals: debtDecimals,
      amount: debtAmount,
    },
    collateral: {
      symbol: position.market.collateralAsset?.symbol ?? 'UNKNOWN',
      address: collateralAddress,
      decimals: collateralDecimals,
      amount: collateralAmount,
    },
    healthFactor,
    protocol: 'morphoblue',
    morpho: {
      uniqueKey: position.market.uniqueKey,
      borrowShares,
      marketParams: {
        loanToken: debtAddress,
        collateralToken: collateralAddress,
        oracle: oracleAddress,
        irm: irmAddress,
        lltv,
      },
    },
  };
}

async function fetchMorphoPositions(
  chain: ChainCfg,
  limit: number,
  hfThreshold: number,
): Promise<{ items: Candidate[]; notes?: string }> {
  if (!DEFAULT_ENDPOINT) {
    return { items: [], notes: 'morpho-endpoint-missing' };
  }

  const body = JSON.stringify({
    query: `query MarketPositionScan($first:Int!, $chainIds:[Int!], $hf:Float!){
      marketPositions(first:$first, where:{chainId_in:$chainIds, healthFactor_lte:$hf}){
        items {
          id
          healthFactor
          user { address }
          market {
            uniqueKey
            irmAddress
            oracleAddress
            lltv
            loanAsset { symbol decimals address }
            collateralAsset { symbol decimals address }
          }
          state {
            borrowAssets
            collateral
            borrowShares
          }
        }
      }
    }`,
    variables: {
      first: Math.max(1, Math.min(limit, 2000)),
      chainIds: [chain.id],
      hf: hfThreshold,
    },
  });

  try {
    const res = await fetch(DEFAULT_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-apollo-operation-name': 'MarketPositionScan',
      },
      body,
    });
    const payload = (await res.json()) as MorphoResponse;
    if (payload.errors?.length) {
      const complexity = payload.extensions?.complexity;
      if (complexity && complexity > DEFAULT_MAX_COMPLEXITY) {
        return { items: [], notes: `morpho-query-too-complex:${complexity}` };
      }
      const message = payload.errors.map((e) => e.message).join('; ');
      return { items: [], notes: `morpho-query-error:${message}` };
    }
    const positions = payload.data?.marketPositions?.items ?? [];
    return {
      items: positions
        .map((item) => toCandidate(chain, item))
        .filter((candidate): candidate is Candidate => candidate !== null),
    };
  } catch (err) {
    return { items: [], notes: `morpho-fetch-error:${(err as Error).message}` };
  }
}

export async function pollMorphoBlueCandidatesOnce(
  cfg: AppConfig,
  chain: ChainCfg,
  first = DEFAULT_LIMIT,
  hfThreshold = DEFAULT_HF_THRESHOLD,
): Promise<{ candidates: Candidate[]; notes?: string }> {
  if (!chain.enabled) return { candidates: [] };
  if (!isSupportedChain(chain.id)) return { candidates: [], notes: 'morpho-unsupported-chain' };

  const { items, notes } = await fetchMorphoPositions(chain, first, hfThreshold);
  return { candidates: items, notes };
}

export async function* streamMorphoBlueCandidates(cfg: AppConfig): AsyncGenerator<Candidate> {
  const chains = cfg.chains.filter((c) => c.enabled && isSupportedChain(c.id));
  if (chains.length === 0) return;

  const dedupe = new Map<string, number>();
  const dedupeWindowMs = Number(process.env.MORPHO_BLUE_DEDUPE_MS ?? 60_000);
  const limit = Number(process.env.MORPHO_BLUE_STREAM_FIRST ?? DEFAULT_LIMIT);
  const hfThreshold = Number(process.env.MORPHO_BLUE_STREAM_HF ?? DEFAULT_HF_THRESHOLD);
const baseInterval = Math.max(MIN_POLL_DELAY_MS, BASE_POLL_DELAY_MS);
  const schedule = new Map<number, { next: number; interval: number }>();
  const boot = Date.now();

  for (const chain of chains) {
    schedule.set(chain.id, { next: boot, interval: baseInterval });
  }

  while (true) {
    const loopStart = Date.now();
    let dispatched = false;

    for (const chain of chains) {
      const current = schedule.get(chain.id) ?? { next: loopStart, interval: baseInterval };
      if (loopStart < current.next) {
        schedule.set(chain.id, current);
        continue;
      }

      dispatched = true;
      const { candidates } = await pollMorphoBlueCandidatesOnce(cfg, chain, limit, hfThreshold);
      const processedAt = Date.now();
      let yielded = 0;

      for (const candidate of candidates) {
        const key = `${candidate.chainId}:${candidate.borrower}:${candidate.debt.address}:${candidate.collateral.address}`;
        const lastSeen = dedupe.get(key) ?? 0;
        if (processedAt - lastSeen < dedupeWindowMs) continue;
        dedupe.set(key, processedAt);
        yielded += 1;
        yield candidate;
      }

      if (yielded > 0) {
        schedule.set(chain.id, { next: processedAt + SUCCESS_DELAY_MS, interval: SUCCESS_DELAY_MS });
      } else {
        const previous = Math.max(MIN_POLL_DELAY_MS, current.interval);
        const grown = Math.min(
          MAX_POLL_DELAY_MS,
          Math.max(MIN_POLL_DELAY_MS, Math.floor(previous * BACKOFF_MULTIPLIER))
        );
        schedule.set(chain.id, { next: processedAt + grown, interval: grown });
      }
    }

    if (!dispatched) {
      const targets = Array.from(schedule.values(), (entry) => entry.next);
      const nextReady = Math.min(...targets);
      const nowTs = Date.now();
      const waitMs = Number.isFinite(nextReady)
        ? Math.max(WAIT_FLOOR_MS, nextReady - nowTs)
        : Math.max(WAIT_FLOOR_MS, baseInterval);
      await sleep(waitMs);
    }
  }
}
