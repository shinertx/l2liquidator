// Aave v3 subgraph driven candidate discovery for near-liquidation accounts
import { log } from '../infra/logger';
import { AppConfig, Market, chainById, ChainCfg, TokenInfo } from '../infra/config';
import { emitAlert } from '../infra/alerts';

export type Candidate = {
  borrower: `0x${string}`;
  chainId: number;
  debt: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint };
  collateral: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint };
  healthFactor: number;
};

export const SUBGRAPH_ENV_KEYS: Record<number, string> = {
  42161: 'AAVE_V3_SUBGRAPH_ARB',
  10: 'AAVE_V3_SUBGRAPH_OP',
  8453: 'AAVE_V3_SUBGRAPH_BASE',
  137: 'AAVE_V3_SUBGRAPH_POLYGON',
};

const SUBGRAPH_IDS: Record<number, string> = {
  42161: 'DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
  10: 'DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb',
  8453: 'GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',
  137: 'Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211',
};

const FALLBACK_SUBGRAPH_URL: Record<number, string> = {
  42161: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
  10: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-optimism',
  8453: '',
  137: '',
};

export function buildSubgraphUrl(chainId: number): string {
  const envKey = SUBGRAPH_ENV_KEYS[chainId];
  const override = envKey ? process.env[envKey] : undefined;
  if (override && !override.includes('MISSING')) return override;
  const apiKey = process.env.GRAPH_API_KEY?.trim();
  const id = SUBGRAPH_IDS[chainId];
  if (apiKey && id) {
    return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${id}`;
  }
  return FALLBACK_SUBGRAPH_URL[chainId] ?? '';
}

// Query for reserves tied to users with health factor below a certain threshold.
const QUERY_USER_RESERVES_BY_HF = `
  query GetUserReservesByHealthFactor($first: Int!) {
    userReserves(
      first: $first,
      orderBy: user__borrowedReservesCount,
      orderDirection: desc,
      where: {
        user_: { borrowedReservesCount_gt: 0 }
      }
    ) {
      user {
        id
      }
      reserve {
        id
        symbol
        decimals
        underlyingAsset
        reserveLiquidationThreshold
        price {
          priceInEth
        }
      }
      usageAsCollateralEnabledOnUser
      currentTotalDebt
      currentATokenBalance
    }
  }
`;

type SubgraphUserReserve = {
  user: {
    id: string;
  };
  reserve: {
    id: string;
    symbol: string;
    decimals: number;
    underlyingAsset?: string;
    reserveLiquidationThreshold?: string;
    price?: {
      priceInEth?: string;
    };
  };
  usageAsCollateralEnabledOnUser: boolean;
  currentTotalDebt?: string;
  currentATokenBalance?: string;
};

const QUERY_USER_RESERVES_BY_USER = `
  query GetUserReservesByUser($user: String!) {
    userReserves(
      where: {
        user: $user
        currentTotalDebt_not: "0"
      }
    ) {
      user {
        id
      }
      reserve {
        id
        symbol
        decimals
        underlyingAsset
        reserveLiquidationThreshold
        price {
          priceInEth
        }
      }
      usageAsCollateralEnabledOnUser
      currentTotalDebt
      currentATokenBalance
    }
  }
`;

const PRICE_SCALE = 100_000_000n; // priceInEth precision (1e8)
const LIQ_THRESHOLD_SCALE = 10_000n;
const AUTH_ERROR_REGEX = /(payment required|auth error|unauthorized|invalid api key|does not exist)/i;
const AUTH_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const lastAuthAlert = new Map<string, number>();

function getIndexerSettings(cfg: AppConfig) {
  const rawPoll = cfg.indexer?.pollMs ?? 500;
  const rawDedupe = cfg.indexer?.dedupeMs ?? 5 * 60 * 1000;
  const rawFirst = cfg.indexer?.subgraphFirst ?? 500;
  const rawThreshold = cfg.indexer?.hfThreshold ?? 1.1;

  return {
    pollMs: Math.max(50, rawPoll),
    hfThreshold: Math.max(1.0, rawThreshold),
    dedupeMs: Math.max(5_000, rawDedupe),
    subgraphFirst: Math.max(1, Math.min(rawFirst, 1000)),
  };
}

export async function graphFetch<T = any>(url: string, query: string, variables: Record<string, any>): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = process.env.GRAPH_API_KEY?.trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`subgraph http ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: any; errors?: any };
  if (json.errors) {
    throw new Error(`subgraph error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

export function parseBigIntOrZero(v: string | undefined): bigint {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

export type UserReserveBucket = {
  reserves: SubgraphUserReserve[];
  totalDebtEth: bigint;
  totalAdjustedCollateralEth: bigint;
};

export function normalizeAddress(addr: string | undefined): `0x${string}` | null {
  if (!addr) return null;
  if (addr.startsWith('0x') && addr.length === 42) {
    return addr.toLowerCase() as `0x${string}`;
  }
  const parts = addr.split('-');
  const candidate = parts[parts.length - 1];
  if (candidate?.startsWith('0x') && candidate.length === 42) {
    return candidate.toLowerCase() as `0x${string}`;
  }
  return null;
}

export function groupUserReserves(reserves: SubgraphUserReserve[]): Map<string, UserReserveBucket> {
  const grouped = new Map<string, UserReserveBucket>();
  for (const reserve of reserves) {
    const userId = reserve.user?.id;
    if (!userId?.startsWith('0x')) continue;
    if (!grouped.has(userId)) {
      grouped.set(userId, { reserves: [], totalDebtEth: 0n, totalAdjustedCollateralEth: 0n });
    }
    const bucket = grouped.get(userId)!;
    bucket.reserves.push(reserve);

    const priceRaw = reserve.reserve.price?.priceInEth;
    const priceInEth = parseBigIntOrZero(priceRaw);
    if (priceInEth === 0n) continue;

    const decimals = typeof reserve.reserve.decimals === 'number' ? reserve.reserve.decimals : Number(reserve.reserve.decimals ?? 0);
    const unit = 10n ** BigInt(decimals);

    const debtBalance = parseBigIntOrZero(reserve.currentTotalDebt);
    if (debtBalance > 0n) {
      const debtEth = (debtBalance * priceInEth) / (unit * PRICE_SCALE);
      bucket.totalDebtEth += debtEth;
    }

    if (reserve.usageAsCollateralEnabledOnUser) {
      const collateralBalance = parseBigIntOrZero(reserve.currentATokenBalance);
      if (collateralBalance > 0n) {
        const collateralEth = (collateralBalance * priceInEth) / (unit * PRICE_SCALE);
        if (collateralEth > 0n) {
          const threshold = parseBigIntOrZero(reserve.reserve.reserveLiquidationThreshold);
          const adjusted = (collateralEth * threshold) / LIQ_THRESHOLD_SCALE;
          bucket.totalAdjustedCollateralEth += adjusted;
        }
      }
    }
  }
  return grouped;
}

export function buildCandidatesFromBucket(
  userId: string,
  chainId: number,
  bucket: UserReserveBucket,
  hfThreshold: number
): Candidate[] {
  const healthFactor = bucket.totalDebtEth === 0n
    ? Number.POSITIVE_INFINITY
    : Number((bucket.totalAdjustedCollateralEth * 1_000_000n) / bucket.totalDebtEth) / 1_000_000;
  if (!Number.isFinite(healthFactor) || healthFactor <= 0 || healthFactor >= hfThreshold) return [];

  const debts: Candidate['debt'][] = [];
  const collaterals: Candidate['collateral'][] = [];

  for (const reserve of bucket.reserves) {
    const address = normalizeAddress(reserve.reserve.underlyingAsset ?? reserve.reserve.id);
    if (!address) continue;
    const decimalsRaw = reserve.reserve.decimals;
    const decimals = typeof decimalsRaw === 'number' ? decimalsRaw : Number(decimalsRaw ?? 0);
    const symbol = reserve.reserve.symbol;

    const debtAmount = parseBigIntOrZero(reserve.currentTotalDebt);
    if (debtAmount > 0n) {
      debts.push({ symbol, address, decimals, amount: debtAmount });
    }

    const collateralAmount = parseBigIntOrZero(reserve.currentATokenBalance);
    if (reserve.usageAsCollateralEnabledOnUser && collateralAmount > 0n) {
      collaterals.push({ symbol, address, decimals, amount: collateralAmount });
    }
  }

  const out: Candidate[] = [];
  for (const debt of debts) {
    for (const collateral of collaterals) {
      if (debt.address === collateral.address) continue;
      out.push({
        borrower: userId as `0x${string}`,
        chainId,
        healthFactor,
        debt,
        collateral,
      });
    }
  }
  return out;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* streamCandidates(cfg: AppConfig): AsyncGenerator<Candidate> {
  const dedupe = new Map<string, number>();
  const { dedupeMs, pollMs, subgraphFirst, hfThreshold } = getIndexerSettings(cfg);
  const pageSize = subgraphFirst;
  while (true) {
    for (const chain of cfg.chains.filter((c) => c.enabled)) {
      const subgraph = buildSubgraphUrl(chain.id);
      if (!subgraph) continue;

      try {
        const t0 = Date.now();
        const response = await graphFetch<{ userReserves: SubgraphUserReserve[] }>(subgraph, QUERY_USER_RESERVES_BY_HF, {
          first: pageSize,
        });
        const reserves = response?.userReserves ?? [];
        const dt = Date.now() - t0;
        log.debug({ chainId: chain.id, userReserves: reserves.length, ms: dt, subgraph }, 'subgraph-poll-hf');

        const grouped = groupUserReserves(reserves);
        for (const [userId, bucket] of grouped.entries()) {
          const candidates = buildCandidatesFromBucket(userId, chain.id, bucket, hfThreshold);
          for (const candidate of candidates) {
            // Deduplicate candidates to avoid processing the same one too frequently
            const key = `${candidate.chainId}:${candidate.borrower}:${candidate.debt.address}:${candidate.collateral.address}`;
            const now = Date.now();
            const last = dedupe.get(key) ?? 0;
            if (now - last < dedupeMs) continue;
            dedupe.set(key, now);
            yield candidate;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err: message, chainId: chain.id, subgraph }, 'aave-indexer-failed');

        if (AUTH_ERROR_REGEX.test(message)) {
          const key = `${chain.id}:${subgraph}`;
          const now = Date.now();
          const last = lastAuthAlert.get(key) ?? 0;
          if (now - last >= AUTH_ALERT_COOLDOWN_MS) {
            lastAuthAlert.set(key, now);
            await emitAlert(
              'Aave subgraph auth error',
              { chainId: chain.id, subgraph, message },
              'critical'
            );
          }
        }
      }
    }

    await delay(pollMs);
  }
}

export async function fetchBorrowerCandidates(
  cfg: AppConfig,
  chain: ChainCfg,
  borrower: `0x${string}`
): Promise<Candidate[]> {
  const subgraph = buildSubgraphUrl(chain.id);
  if (!subgraph) return [];

  const userId = borrower.toLowerCase();
  const { hfThreshold } = getIndexerSettings(cfg);
  try {
    const response = await graphFetch<{ userReserves: SubgraphUserReserve[] }>(
      subgraph,
      QUERY_USER_RESERVES_BY_USER,
      { user: userId }
    );
    const reserves = response?.userReserves ?? [];
    if (reserves.length === 0) return [];
    const grouped = groupUserReserves(reserves);
    const bucket = grouped.get(userId);
    if (!bucket) return [];
    return buildCandidatesFromBucket(userId, chain.id, bucket, hfThreshold);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ chainId: chain.id, borrower: userId, err: message }, 'fetch-borrower-candidates-failed');
    return [];
  }
}

export async function pollChainCandidatesOnce(
  cfg: AppConfig,
  chain: ChainCfg,
  first = 500
): Promise<Candidate[]> {
  const subgraph = buildSubgraphUrl(chain.id);
  if (!subgraph) return [];
  const out: Candidate[] = [];

  const { subgraphFirst, hfThreshold } = getIndexerSettings(cfg);
  const limit = subgraphFirst || first;

  try {
    const response = await graphFetch<{ userReserves: SubgraphUserReserve[] }>(
      subgraph,
      QUERY_USER_RESERVES_BY_HF,
      { first: limit }
    );
    const reserves = response?.userReserves ?? [];
    const grouped = groupUserReserves(reserves);
    for (const [userId, bucket] of grouped.entries()) {
      const candidates = buildCandidatesFromBucket(userId, chain.id, bucket, hfThreshold);
      for (const candidate of candidates) {
        out.push(candidate);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ chainId: chain.id, err: message }, 'poll-chain-candidates-failed');
  }

  return out;
}
