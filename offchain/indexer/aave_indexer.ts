// Aave v3 subgraph driven candidate discovery for near-liquidation accounts
import { log } from '../infra/logger';
import { AppConfig, ChainCfg, ProtocolKey } from '../infra/config';
import { emitAlert } from '../infra/alerts';
import { counter } from '../infra/metrics';
import { lookupToken } from '../util/symbols';
import { getPublicClient } from '../infra/rpc_clients';
import { oraclePriceUsd } from './price_watcher';

export type Candidate = {
  borrower: `0x${string}`;
  chainId: number;
  debt: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint };
  collateral: { symbol: string; address: `0x${string}`; decimals: number; amount: bigint };
  healthFactor: number;
  protocol: ProtocolKey;
  morpho?: {
    uniqueKey: string;
    borrowShares: bigint;
    marketParams: {
      loanToken: `0x${string}`;
      collateralToken: `0x${string}`;
      oracle: `0x${string}`;
      irm: `0x${string}`;
      lltv: bigint;
    };
  };
};

export const SUBGRAPH_ENV_KEYS: Record<number, string> = {
  1: 'AAVE_V3_SUBGRAPH_ETH',
  42161: 'AAVE_V3_SUBGRAPH_ARB',
  10: 'AAVE_V3_SUBGRAPH_OP',
  8453: 'AAVE_V3_SUBGRAPH_BASE',
  137: 'AAVE_V3_SUBGRAPH_POLYGON',
};

// Seamless Protocol subgraph URLs (Base only)
export const SEAMLESS_SUBGRAPH_URL: Record<number, string> = {
  8453: 'https://api.goldsky.com/api/public/project_clsk1wzatdsls01wchl2e4n0y/subgraphs/seamless-mainnet/prod/gn',
};

const SUBGRAPH_IDS: Record<number, string> = {
  42161: 'DLuE98kEb5pQNXAcKFQGQgfSQ57Xdou4jnVbAEqMfy3B',
  10: 'DSfLz8oQBUeU5atALgUFQKMTSYV9mZAVYp4noLSXAfvb',
  8453: 'GQFbb95cE6d8mV989mL5figjaGaKCQB3xqYrr1bRyXqF',
  137: 'Co2URyXjnxaw8WqxKyVHdirq9Ahhm5vcTs4dMedAq211',
};

const FALLBACK_SUBGRAPH_URL: Record<number, string> = {
  1: '',
  42161: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-arbitrum',
  10: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-optimism',
  8453: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-base',
  137: 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon',
};

type IndexerOverride = {
  until: number;
  hfThreshold?: number;
  subgraphFirst?: number;
};

const indexerOverrides = new Map<number, IndexerOverride>();
const forcedFallbackUntil = new Map<number, number>();
const fallbackErrorState = new Map<number, { consecutive5xx: number }>();

const FALLBACK_TRIGGER = Number(process.env.SUBGRAPH_FALLBACK_TRIGGER ?? 3);
const FALLBACK_DURATION_MS = Number(process.env.SUBGRAPH_FALLBACK_DURATION_MS ?? 5 * 60 * 1000);
const MISSING_PLACEHOLDER = '\u0000MISSING:';

const GRAPH_MAX_CONCURRENCY = Math.max(1, Number(process.env.GRAPH_MAX_CONCURRENCY ?? 2));
const GRAPH_RATE_WINDOW_MS = Math.max(250, Number(process.env.GRAPH_RATE_WINDOW_MS ?? 1_000));
const GRAPH_MAX_REQUESTS_PER_WINDOW = Math.max(1, Number(process.env.GRAPH_MAX_REQUESTS_PER_WINDOW ?? 8));
const GRAPH_WAIT_STEP_MS = Math.max(25, Number(process.env.GRAPH_WAIT_STEP_MS ?? 50));

let graphInFlight = 0;
const graphTimestamps: number[] = [];

function hydrateGraphUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (!url.includes('${GRAPH_API_KEY}')) return url;
  const apiKey = process.env.GRAPH_API_KEY?.trim();
  if (!apiKey) return undefined;
  return url.replace('${GRAPH_API_KEY}', apiKey);
}

export type AaveIndexerOptions = {
  protocol: ProtocolKey;
  subgraphOverrides?: Partial<Record<number, string | undefined>>;
  chainIds?: number[];
};

const DEFAULT_INDEXER_OPTIONS: AaveIndexerOptions = {
  protocol: 'aavev3',
};

function normalizeOptions(options?: Partial<AaveIndexerOptions>): AaveIndexerOptions {
  return {
    protocol: options?.protocol ?? DEFAULT_INDEXER_OPTIONS.protocol,
    subgraphOverrides: options?.subgraphOverrides,
    chainIds: options?.chainIds,
  };
}

function isValidOverride(value: string | undefined): value is string {
  if (!value) return false;
  if (value.includes(MISSING_PLACEHOLDER)) return false;
  if (value.trim().length === 0) return false;
  return true;
}

export function requestIndexerBoost(
  chainId: number,
  options: { hfThreshold?: number; subgraphFirst?: number; durationMs?: number }
): number {
  const durationMs = Math.max(options.durationMs ?? 5 * 60 * 1000, 5_000);
  const until = Date.now() + durationMs;
  const existing = indexerOverrides.get(chainId) ?? { until: 0 };
  const next: IndexerOverride = {
    until,
    hfThreshold: options.hfThreshold ?? existing.hfThreshold,
    subgraphFirst: options.subgraphFirst ?? existing.subgraphFirst,
  };
  indexerOverrides.set(chainId, next);
  log.warn({ chainId, hfThreshold: next.hfThreshold, subgraphFirst: next.subgraphFirst, durationMs }, 'indexer-boost-scheduled');
  return until;
}

function activateFallback(chainId: number, status: number | null): void {
  const fallbackUrl = hydrateGraphUrl(FALLBACK_SUBGRAPH_URL[chainId]);
  if (!fallbackUrl) return;
  const until = Date.now() + FALLBACK_DURATION_MS;
  const previous = forcedFallbackUntil.get(chainId) ?? 0;
  if (previous >= until) return;
  forcedFallbackUntil.set(chainId, until);
  fallbackErrorState.set(chainId, { consecutive5xx: 0 });
  log.warn({ chainId, fallbackUrl, durationMs: FALLBACK_DURATION_MS, status }, 'subgraph-fallback-activated');
}

function markSubgraphSuccess(chainId: number): void {
  fallbackErrorState.set(chainId, { consecutive5xx: 0 });
  const until = forcedFallbackUntil.get(chainId);
  if (until && Date.now() > until) {
    forcedFallbackUntil.delete(chainId);
  }
}

function recordSubgraphError(chainId: number, status: number | null): void {
  if (status == null || (status < 500 && status !== 429) || status >= 600) return;
  const state = fallbackErrorState.get(chainId) ?? { consecutive5xx: 0 };
  state.consecutive5xx += 1;
  fallbackErrorState.set(chainId, state);
  if (state.consecutive5xx >= FALLBACK_TRIGGER) {
    activateFallback(chainId, status);
  }
}

export function buildSubgraphUrl(
  chainId: number,
  protocol: ProtocolKey,
  overrideMap?: Partial<Record<number, string | undefined>>
): string {
  // If protocol is seamless, use Seamless subgraph
  if (protocol === 'seamless') {
    const seamlessUrl = SEAMLESS_SUBGRAPH_URL[chainId];
    if (seamlessUrl) return seamlessUrl;
    // Fall through to Aave v3 if Seamless not available for this chain
  }

  const override = overrideMap?.[chainId];
  if (isValidOverride(override)) {
    return override;
  }
  const fallbackUntil = forcedFallbackUntil.get(chainId);
  const now = Date.now();
  if (fallbackUntil && now >= fallbackUntil) {
    forcedFallbackUntil.delete(chainId);
  }
  if (fallbackUntil && now < fallbackUntil) {
    const fallbackUrl = FALLBACK_SUBGRAPH_URL[chainId];
    const hydrated = hydrateGraphUrl(fallbackUrl);
    if (hydrated) return hydrated;
  }
  const envKey = SUBGRAPH_ENV_KEYS[chainId];
  let envOverride = envKey ? hydrateGraphUrl(process.env[envKey]) : undefined;
  // The Graph gateway does not support name-based slugs; require ID-based URLs.
  // If a gateway URL uses /subgraphs/name/ (commonly copy-pasted), ignore it to avoid 404 spam.
  if (envOverride && /gateway\.thegraph\.com\/.+\/subgraphs\/name\//i.test(envOverride)) {
    envOverride = undefined;
  }
  if (isValidOverride(envOverride)) return envOverride;
  const apiKey = process.env.GRAPH_API_KEY?.trim();
  const id = SUBGRAPH_IDS[chainId];
  if (apiKey && id) {
    return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${id}`;
  }
  return hydrateGraphUrl(FALLBACK_SUBGRAPH_URL[chainId]) ?? '';
}

// Query for reserves tied to users with health factor below a certain threshold.
const QUERY_USER_RESERVE_IDS = `
  query GetCandidateUsers($first: Int!) {
    userReserves(
      first: $first,
      orderBy: currentTotalDebt,
      orderDirection: desc,
      where: {
        currentTotalDebt_not: "0",
        user_: {
          borrowedReservesCount_gt: 0
        }
      }
    ) {
      user {
        id
      }
    }
  }
`;

type SubgraphUserReserve = {
  user: {
    id: string;
    healthFactor?: string;
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

const QUERY_USER_RESERVES_BY_USERS = `
  query GetUserReservesByUsers($users: [String!]!, $limit: Int!) {
    userReserves(
      first: $limit,
      where: {
        and: [
          { user_in: $users },
          {
            or: [
              { currentTotalDebt_not: "0" },
              { currentATokenBalance_not: "0" }
            ]
          }
        ]
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

const QUERY_USER_RESERVES_BY_USER = `
  query GetUserReservesByUser($user: String!, $limit: Int!) {
    userReserves(
      first: $limit,
      where: {
        and: [
          { user: $user },
          {
            or: [
              { currentTotalDebt_not: "0" },
              { currentATokenBalance_not: "0" }
            ]
          }
        ]
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
const HF_SCALE = 1_000_000n;
const AUTH_ERROR_REGEX = /(payment required|auth error|unauthorized|invalid api key|does not exist)/i;
const AUTH_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const lastAuthAlert = new Map<string, number>();
const SUBGRAPH_BACKOFF_BASE_MS = Number(process.env.SUBGRAPH_BACKOFF_BASE_MS ?? 5_000);
const SUBGRAPH_BACKOFF_MAX_MS = Number(process.env.SUBGRAPH_BACKOFF_MAX_MS ?? 120_000);
const HF_THRESHOLD_FLOOR = Math.max(0.1, Number(process.env.AAVE_INDEXER_HF_FLOOR ?? 0.3));

const USER_SCAN_MULTIPLIER = Math.max(1, Number(process.env.AAVE_INDEXER_SCAN_MULTIPLIER ?? 4));
const TOP_USER_SCAN_CAP = Math.max(100, Math.min(1_000, Number(process.env.AAVE_INDEXER_SCAN_CAP ?? 1_000)));
const USER_BATCH_SIZE = Math.max(1, Number(process.env.AAVE_INDEXER_USER_BATCH_SIZE ?? 20));
const BATCH_RESULT_LIMIT = Math.max(100, Math.min(1_000, Number(process.env.AAVE_INDEXER_BATCH_RESULT_LIMIT ?? 1_000)));
const RESERVE_MULTIPLIER = Math.max(16, Number(process.env.AAVE_INDEXER_RESERVE_MULTIPLIER ?? 64));
const BATCH_DELAY_MS = Math.max(0, Number(process.env.AAVE_INDEXER_BATCH_DELAY_MS ?? 50));
const SINGLE_USER_RESERVE_LIMIT = Math.max(200, Number(process.env.AAVE_INDEXER_SINGLE_USER_LIMIT ?? 600));

async function acquireGraphSlot(): Promise<void> {
  while (true) {
    const now = Date.now();
    while (graphTimestamps.length > 0 && now - graphTimestamps[0] >= GRAPH_RATE_WINDOW_MS) {
      graphTimestamps.shift();
    }
    const canIssue = graphInFlight < GRAPH_MAX_CONCURRENCY && graphTimestamps.length < GRAPH_MAX_REQUESTS_PER_WINDOW;
    if (canIssue) {
      graphInFlight += 1;
      graphTimestamps.push(now);
      return;
    }
    const oldest = graphTimestamps[0] ?? now;
    const waitMs = Math.max(GRAPH_WAIT_STEP_MS, GRAPH_RATE_WINDOW_MS - (now - oldest));
    await delay(waitMs);
  }
}

function releaseGraphSlot(): void {
  graphInFlight = Math.max(0, graphInFlight - 1);
}

type BackoffState = { delayMs: number; until: number };

function extractStatusCode(message: string): number | null {
  const statusMatch = message.match(/status:\s*(\d{3})/i);
  if (statusMatch) return Number(statusMatch[1]);
  const httpMatch = message.match(/http\s+(\d{3})/i);
  if (httpMatch) return Number(httpMatch[1]);
  return null;
}

function getIndexerSettings(cfg: AppConfig, chainId?: number) {
  const rawPoll = cfg.indexer?.pollMs ?? 500;
  const rawDedupe = cfg.indexer?.dedupeMs ?? 5 * 60 * 1000;
  const rawFirst = cfg.indexer?.subgraphFirst ?? 500;
  const rawThreshold = cfg.indexer?.hfThreshold ?? cfg.risk.healthFactorMax ?? 0.985;
  if (chainId != null) {
    const override = indexerOverrides.get(chainId);
    if (override) {
      if (override.until <= Date.now()) {
        indexerOverrides.delete(chainId);
      } else {
        return {
          pollMs: Math.max(50, rawPoll),
          hfThreshold: Math.max(HF_THRESHOLD_FLOOR, override.hfThreshold ?? rawThreshold),
          dedupeMs: Math.max(5_000, rawDedupe),
          subgraphFirst: Math.max(1, Math.min(override.subgraphFirst ?? rawFirst, 1000)),
        };
      }
    }
  }

  return {
    pollMs: Math.max(50, rawPoll),
    hfThreshold: Math.max(HF_THRESHOLD_FLOOR, rawThreshold),
    dedupeMs: Math.max(5_000, rawDedupe),
    subgraphFirst: Math.max(1, Math.min(rawFirst, 1000)),
  };
}

export async function graphFetch<T = any>(url: string, query: string, variables: Record<string, any>): Promise<T> {
  await acquireGraphSlot();
  try {
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
      const error = new Error(`subgraph http ${res.status}: ${text}`);
      (error as any).status = res.status;
      (error as any).body = text;
      throw error;
    }

    const json = (await res.json()) as { data?: any; errors?: any };
    if (json.errors) {
      throw new Error(`subgraph error: ${JSON.stringify(json.errors)}`);
    }
    return json.data as T;
  } finally {
    releaseGraphSlot();
  }
}

export function parseBigIntOrZero(v: string | undefined): bigint {
  try {
    return v ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
}

function parseHealthFactor(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

export type UserReserveBucket = {
  reserves: SubgraphUserReserve[];
  totalDebtEth: bigint;
  totalAdjustedCollateralEth: bigint;
  subgraphHealthFactor: number | null;
  missingDebtPrices: Set<string>;
  missingCollateralPrices: Set<string>;
  chainLabel: string;
};

type PriceFallbackContext = {
  chain?: ChainCfg;
  cache: Map<string, bigint>;
  client?: ReturnType<typeof getPublicClient>;
  nativePriceLoaded: boolean;
  nativePriceUsd?: number | null;
};

type PriceFallbackResult = {
  priceInEth: bigint;
  source: 'oracle';
};

async function resolveFallbackPriceInEth(
  ctx: PriceFallbackContext,
  reserve: SubgraphUserReserve,
): Promise<PriceFallbackResult | null> {
  const chain = ctx.chain;
  if (!chain) return null;
  const tokens = chain.tokens;
  if (!tokens) return null;

  const symbol = reserve.reserve.symbol ?? 'UNKNOWN';
  const address = normalizeAddress(reserve.reserve.underlyingAsset ?? reserve.reserve.id);
  const cacheKey = (address ?? symbol ?? '').toLowerCase();
  if (!cacheKey) return null;

  if (ctx.cache.has(cacheKey)) {
    const cached = ctx.cache.get(cacheKey)!;
    if (cached > 0n) {
      return { priceInEth: cached, source: 'oracle' };
    }
    return null;
  }

  const tokenEntry = lookupToken(tokens, symbol, address ?? undefined);
  if (!tokenEntry?.value?.chainlinkFeed) {
    ctx.cache.set(cacheKey, 0n);
    return null;
  }

  if (!ctx.client) {
    ctx.client = getPublicClient(chain);
  }

  try {
    const tokenPriceUsd = await oraclePriceUsd(ctx.client!, tokenEntry.value);
    if (tokenPriceUsd == null || tokenPriceUsd <= 0) {
      ctx.cache.set(cacheKey, 0n);
      return null;
    }

    if (!ctx.nativePriceLoaded) {
      ctx.nativePriceLoaded = true;
      const nativeToken = tokens.WETH ?? tokens.ETH;
      if (nativeToken?.chainlinkFeed) {
        const nativePrice = await oraclePriceUsd(ctx.client!, nativeToken);
        ctx.nativePriceUsd = nativePrice && nativePrice > 0 ? nativePrice : null;
      } else {
        ctx.nativePriceUsd = null;
      }
    }

    const nativePriceUsd = ctx.nativePriceUsd;
    if (!nativePriceUsd || nativePriceUsd <= 0) {
      ctx.cache.set(cacheKey, 0n);
      return null;
    }

    const scaledNumber = Math.round((tokenPriceUsd * Number(PRICE_SCALE)) / nativePriceUsd);
    if (!Number.isFinite(scaledNumber) || scaledNumber <= 0) {
      ctx.cache.set(cacheKey, 0n);
      return null;
    }

    const scaled = BigInt(scaledNumber);
    ctx.cache.set(cacheKey, scaled);
    return { priceInEth: scaled, source: 'oracle' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ chainId: chain.id, symbol, address, err: message }, 'subgraph-price-fallback-failed');
    ctx.cache.set(cacheKey, 0n);
    return null;
  }
}

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

export async function groupUserReserves(reserves: SubgraphUserReserve[], chain?: ChainCfg): Promise<Map<string, UserReserveBucket>> {
  const grouped = new Map<string, UserReserveBucket>();
  const chainLabel = chain?.name ?? String(chain?.id ?? 'unknown');
  const fallbackCtx: PriceFallbackContext = {
    chain,
    cache: new Map<string, bigint>(),
    nativePriceLoaded: false,
  };

  for (const reserve of reserves) {
    const userId = reserve.user?.id;
    if (!userId?.startsWith('0x')) continue;
    if (!grouped.has(userId)) {
      grouped.set(userId, {
        reserves: [],
        totalDebtEth: 0n,
        totalAdjustedCollateralEth: 0n,
        subgraphHealthFactor: parseHealthFactor(reserve.user?.healthFactor),
        missingDebtPrices: new Set<string>(),
        missingCollateralPrices: new Set<string>(),
        chainLabel,
      });
    }
    const bucket = grouped.get(userId)!;
    if (bucket.subgraphHealthFactor == null) {
      bucket.subgraphHealthFactor = parseHealthFactor(reserve.user?.healthFactor);
    }
    bucket.reserves.push(reserve);

    const priceRaw = reserve.reserve.price?.priceInEth;
    const decimals = typeof reserve.reserve.decimals === 'number' ? reserve.reserve.decimals : Number(reserve.reserve.decimals ?? 0);
    const unit = 10n ** BigInt(decimals);

    const debtBalance = parseBigIntOrZero(reserve.currentTotalDebt);
    const collateralBalance = parseBigIntOrZero(reserve.currentATokenBalance);
    let priceInEth = parseBigIntOrZero(priceRaw);
    let fallbackSource: PriceFallbackResult['source'] | null = null;

    if (priceInEth === 0n) {
      const fallback = await resolveFallbackPriceInEth(fallbackCtx, reserve);
      if (fallback && fallback.priceInEth > 0n) {
        priceInEth = fallback.priceInEth;
        fallbackSource = fallback.source;
        const symbol = reserve.reserve.symbol ?? 'UNKNOWN';
        log.debug({ chainId: chain?.id, user: userId, symbol, source: fallbackSource }, 'subgraph-price-fallback');
      }
    }

    if (priceInEth === 0n) {
      const symbol = reserve.reserve.symbol ?? 'UNKNOWN';
      if (debtBalance > 0n && !bucket.missingDebtPrices.has(symbol)) {
        bucket.missingDebtPrices.add(symbol);
        counter.subgraphPriceZero.inc({ chain: chainLabel, token: symbol, role: 'debt' });
        log.debug({ chainId: chain?.id, user: userId, symbol, role: 'debt' }, 'subgraph-price-zero');
      }
      if (reserve.usageAsCollateralEnabledOnUser && collateralBalance > 0n && !bucket.missingCollateralPrices.has(symbol)) {
        bucket.missingCollateralPrices.add(symbol);
        counter.subgraphPriceZero.inc({ chain: chainLabel, token: symbol, role: 'collateral' });
        log.debug({ chainId: chain?.id, user: userId, symbol, role: 'collateral' }, 'subgraph-price-zero');
      }
      continue;
    }

    if (debtBalance > 0n) {
      const debtValue = (debtBalance * priceInEth * HF_SCALE) / (unit * PRICE_SCALE);
      bucket.totalDebtEth += debtValue;
      if (fallbackSource) {
        const symbol = reserve.reserve.symbol ?? 'UNKNOWN';
        counter.subgraphPriceFallback.inc({ chain: chainLabel, token: symbol, role: 'debt', source: fallbackSource });
      }
    }

    if (reserve.usageAsCollateralEnabledOnUser && collateralBalance > 0n) {
      const collateralValue = (collateralBalance * priceInEth * HF_SCALE) / (unit * PRICE_SCALE);
      if (collateralValue > 0n) {
        const threshold = parseBigIntOrZero(reserve.reserve.reserveLiquidationThreshold);
        const adjusted = (collateralValue * threshold) / LIQ_THRESHOLD_SCALE;
        bucket.totalAdjustedCollateralEth += adjusted;
        if (fallbackSource) {
          const symbol = reserve.reserve.symbol ?? 'UNKNOWN';
          counter.subgraphPriceFallback.inc({ chain: chainLabel, token: symbol, role: 'collateral', source: fallbackSource });
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
  hfThreshold: number,
  protocol: ProtocolKey = 'aavev3'
): Candidate[] {
  const derivedHealthFactor = bucket.totalDebtEth === 0n
    ? Number.POSITIVE_INFINITY
    : Number(bucket.totalAdjustedCollateralEth) / Number(bucket.totalDebtEth);
  const missingDebtPrices = bucket.missingDebtPrices.size > 0;
  const missingCollateralPrices = bucket.missingCollateralPrices.size > 0;
  let healthFactor =
    bucket.subgraphHealthFactor != null ? bucket.subgraphHealthFactor : derivedHealthFactor;
  if (!Number.isFinite(healthFactor) || healthFactor <= 0) {
    healthFactor = derivedHealthFactor;
  }
  if ((!Number.isFinite(healthFactor) || healthFactor <= 0) && (missingDebtPrices || missingCollateralPrices)) {
    const fallbackHf = Math.max(0.0001, Math.min(hfThreshold - 0.0001, 0.95));
    const chainLabel = bucket.chainLabel ?? String(chainId);
    log.debug({
      chainId,
      borrower: userId,
      fallbackHf,
      missingDebtPrices: [...bucket.missingDebtPrices],
      missingCollateralPrices: [...bucket.missingCollateralPrices],
    }, 'missing-price-fallback-hf');
    healthFactor = fallbackHf;
  }
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
        protocol,
      });
    }
  }
  return out;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (size <= 0) return [values];
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function fetchCandidateReserves(
  chainId: number,
  subgraph: string,
  maxUsers: number
): Promise<SubgraphUserReserve[]> {
  if (maxUsers <= 0) return [];

  const scanFirst = Math.max(1, Math.min(maxUsers * USER_SCAN_MULTIPLIER, TOP_USER_SCAN_CAP));
  const topResponse = await graphFetch<{ userReserves: Array<{ user?: { id?: string } | null }> }>(
    subgraph,
    QUERY_USER_RESERVE_IDS,
    { first: scanFirst }
  );
  markSubgraphSuccess(chainId);

  const seen = new Set<string>();
  for (const entry of topResponse?.userReserves ?? []) {
    const userId = entry.user?.id?.toLowerCase();
    if (!userId) continue;
    if (seen.has(userId)) continue;
    seen.add(userId);
    if (seen.size >= maxUsers) break;
  }

  if (seen.size === 0) return [];
  const selected = Array.from(seen);

  const out: SubgraphUserReserve[] = [];
  const batches = chunkArray(selected, USER_BATCH_SIZE);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const limit = Math.min(
      BATCH_RESULT_LIMIT,
      Math.max(batch.length * RESERVE_MULTIPLIER, batch.length * 16)
    );
    const response = await graphFetch<{ userReserves: SubgraphUserReserve[] }>(
      subgraph,
      QUERY_USER_RESERVES_BY_USERS,
      { users: batch, limit }
    );
    out.push(...(response?.userReserves ?? []));
    markSubgraphSuccess(chainId);
    if (BATCH_DELAY_MS > 0 && i < batches.length - 1) {
      await delay(BATCH_DELAY_MS);
    }
  }

  return out;
}

export async function* streamCandidates(
  cfg: AppConfig,
  options?: Partial<AaveIndexerOptions>
): AsyncGenerator<Candidate> {
  const opts = normalizeOptions(options);
  const allowedChainSet = opts.chainIds ? new Set(opts.chainIds) : undefined;
  const dedupe = new Map<string, number>();
  const { dedupeMs, pollMs } = getIndexerSettings(cfg);
  const backoffs = new Map<number, BackoffState>();
  while (true) {
    for (const chain of cfg.chains.filter(
      (c) => c.enabled && (!allowedChainSet || allowedChainSet.has(c.id))
    )) {
      const subgraph = buildSubgraphUrl(chain.id, opts.protocol, opts.subgraphOverrides);
      if (!subgraph) continue;

      const backoff = backoffs.get(chain.id);
      if (backoff && Date.now() < backoff.until) {
        continue;
      }

      try {
        const t0 = Date.now();
        const { subgraphFirst, hfThreshold } = getIndexerSettings(cfg, chain.id);
        const maxUsers = Math.max(1, subgraphFirst);
        const reserves = await fetchCandidateReserves(chain.id, subgraph, maxUsers);
        const dt = Date.now() - t0;
        log.debug({ chainId: chain.id, users: maxUsers, userReserves: reserves.length, ms: dt, subgraph }, 'subgraph-poll-users');

  const grouped = await groupUserReserves(reserves, chain);
        if (backoffs.has(chain.id)) {
          backoffs.delete(chain.id);
        }
        for (const [userId, bucket] of grouped.entries()) {
          const candidates = buildCandidatesFromBucket(
            userId,
            chain.id,
            bucket,
            hfThreshold,
            opts.protocol
          );
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
        const statusFromError = typeof (err as any)?.status === 'number'
          ? Number((err as any).status)
          : undefined;
        const status = statusFromError ?? extractStatusCode(message);
        recordSubgraphError(chain.id, status ?? null);
        if (status != null && status >= 500 && status < 600) {
          const previous = backoffs.get(chain.id);
          const base = Math.max(1_000, SUBGRAPH_BACKOFF_BASE_MS);
          const nextDelay = Math.min(previous ? previous.delayMs * 2 : base, SUBGRAPH_BACKOFF_MAX_MS);
          const until = Date.now() + nextDelay;
          backoffs.set(chain.id, { delayMs: nextDelay, until });
          log.warn({ chainId: chain.id, subgraph, status, backoffMs: nextDelay }, 'aave-indexer-backoff');
        }

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
  borrower: `0x${string}`,
  options?: Partial<AaveIndexerOptions>
): Promise<Candidate[]> {
  const opts = normalizeOptions(options);
  if (opts.chainIds && !opts.chainIds.includes(chain.id)) {
    return [];
  }
  const subgraph = buildSubgraphUrl(chain.id, opts.protocol, opts.subgraphOverrides);
  if (!subgraph) return [];

  const userId = borrower.toLowerCase();
  const { hfThreshold } = getIndexerSettings(cfg, chain.id);
  try {
    const response = await graphFetch<{ userReserves: SubgraphUserReserve[] }>(
      subgraph,
      QUERY_USER_RESERVES_BY_USER,
      { user: userId, limit: SINGLE_USER_RESERVE_LIMIT }
    );
    const reserves = response?.userReserves ?? [];
    markSubgraphSuccess(chain.id);
    if (reserves.length === 0) return [];
  const grouped = await groupUserReserves(reserves, chain);
    const bucket = grouped.get(userId);
    if (!bucket) return [];
    return buildCandidatesFromBucket(userId, chain.id, bucket, hfThreshold, opts.protocol);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ chainId: chain.id, borrower: userId, err: message }, 'fetch-borrower-candidates-failed');
    const statusFromError = typeof (err as any)?.status === 'number' ? Number((err as any).status) : undefined;
    recordSubgraphError(chain.id, statusFromError ?? extractStatusCode(message));
    return [];
  }
}

export async function pollChainCandidatesOnce(
  cfg: AppConfig,
  chain: ChainCfg,
  first = 500,
  options?: Partial<AaveIndexerOptions>
): Promise<Candidate[]> {
  const opts = normalizeOptions(options);
  if (opts.chainIds && !opts.chainIds.includes(chain.id)) {
    return [];
  }
  const subgraph = buildSubgraphUrl(chain.id, opts.protocol, opts.subgraphOverrides);
  if (!subgraph) return [];
  const out: Candidate[] = [];

  const { subgraphFirst, hfThreshold } = getIndexerSettings(cfg, chain.id);
  const limit = subgraphFirst || first;

  try {
  const reserves = await fetchCandidateReserves(chain.id, subgraph, Math.max(1, limit));
  const grouped = await groupUserReserves(reserves, chain);
    for (const [userId, bucket] of grouped.entries()) {
      const candidates = buildCandidatesFromBucket(
        userId,
        chain.id,
        bucket,
        hfThreshold,
        opts.protocol,
      );
      for (const candidate of candidates) {
        out.push(candidate);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ chainId: chain.id, err: message }, 'poll-chain-candidates-failed');
    const statusFromError = typeof (err as any)?.status === 'number' ? Number((err as any).status) : undefined;
    recordSubgraphError(chain.id, statusFromError ?? extractStatusCode(message));
  }

  return out;
}
