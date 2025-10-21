import type { Address, Chain, PublicClient, Transport } from 'viem';
import { ChainCfg, TokenInfo, loadConfig } from '../infra/config';
import { bestRoute, RouteOption } from '../simulator/router';
import { buildRouteOptions } from '../util/routes';
import { isValidAddress, normalizeAddress } from '../util/address';
import { log } from '../infra/logger';

type RpcClient = PublicClient<Transport, Chain | undefined, any>;

const ORACLE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours – stablecoin feeds on L2 can stay flat for long stretches
const ORACLE_ERROR_RETRY_MS = 15_000; // retry quickly after transient RPC failures
const ROUTE_TTL_MS = Math.max(2_000, Number(process.env.ROUTE_CACHE_TTL_MS ?? 15_000));
const ROUTE_ERROR_TTL_MS = Math.max(1_000, Number(process.env.ROUTE_CACHE_ERROR_TTL_MS ?? 5_000));

type OracleObservation = {
  feed: string | null;
  priceUsd: number | null;
  decimals: number | null;
  updatedAt: number | null;
  stale: boolean;
  rawAnswer?: string;
  answeredInRound?: string;
  error?: string;
};

type OracleCacheEntry = {
  value: OracleObservation | undefined;
  expires: number;
  pending?: Promise<OracleObservation>;
};

type RouteCacheEntry = {
  value: Awaited<ReturnType<typeof bestRoute>> | undefined;
  expires: number;
  pending?: Promise<Awaited<ReturnType<typeof bestRoute>> | undefined>;
};

const oracleCache = new Map<string, OracleCacheEntry>();
const routeCache = new Map<string, RouteCacheEntry>();
let cachedConfig: ReturnType<typeof loadConfig> | null = null;

function getCachedConfig() {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

function findTokenSymbol(chain: ChainCfg, token: TokenInfo): string | undefined {
  if (!chain.tokens) return undefined;
  const target = token.address.toLowerCase();
  for (const [symbol, info] of Object.entries(chain.tokens)) {
    if (info.address?.toLowerCase() === target) {
      return symbol;
    }
  }
  return undefined;
}

function preferredStableSymbols(chain: ChainCfg): string[] {
  const candidates = ['USDbC', 'USDC', 'USDCn', 'USDT', 'DAI', 'GHO'];
  return candidates.filter((symbol) => chain.tokens?.[symbol] != null);
}

export function invalidateOracleFeed(feedOrToken: string | TokenInfo) {
  const key =
    typeof feedOrToken === 'string'
      ? feedOrToken.toLowerCase()
      : (feedOrToken.chainlinkFeed ?? '').toLowerCase();
  if (!key) return;
  oracleCache.delete(key);
}

function cacheKeyOracle(token: TokenInfo): string | undefined {
  if (!token.chainlinkFeed) return undefined;
  return token.chainlinkFeed.toLowerCase();
}

function cacheKeyRoute(
  chain: ChainCfg,
  collateral: TokenInfo,
  debt: TokenInfo,
  routeOptions?: RouteOption[]
): string {
  let key = `${chain.id}:${collateral.address.toLowerCase()}:${debt.address.toLowerCase()}`;
  if (routeOptions && routeOptions.length > 0) {
    // Include router type and key properties in cache key
    const optionsKey = routeOptions
      .map((opt) => {
        if (opt.type === 'UniV3') return `${opt.router.toLowerCase()}:uv3:${opt.fee}`;
        if (opt.type === 'UniV2') return `${opt.router.toLowerCase()}:uv2`;
        if (opt.type === 'SolidlyV2') return `${opt.router.toLowerCase()}:solidly:${opt.stable}`;
        if (opt.type === 'UniV3Multi') return `${opt.router.toLowerCase()}:uv3m:${opt.fees.join(',')}`;
        // Fallback for any other type
        return (opt as any).router?.toLowerCase() || 'unknown';
      })
      .sort()
      .join('|');
    key += `:${optionsKey}`;
  }
  return key;
}

export type OraclePriceDetail = OracleObservation & {
  ageSeconds: number | null;
  hasFeed: boolean;
};

async function loadOracleDetail(client: RpcClient, token: TokenInfo): Promise<OracleObservation> {
  const rawFeed = token.chainlinkFeed;
  if (!rawFeed) {
    return {
      feed: null,
      priceUsd: null,
      decimals: null,
      updatedAt: null,
      stale: true,
      error: 'missing-feed',
    };
  }
  if (!isValidAddress(rawFeed)) {
    return {
      feed: rawFeed,
      priceUsd: null,
      decimals: null,
      updatedAt: null,
      stale: true,
      error: 'invalid-feed',
    };
  }
  const feed = normalizeAddress(rawFeed) as Address;
  try {
    const decimals = (await client.readContract({
      address: feed,
      abi: FEED_ABI,
      functionName: 'decimals',
      args: [],
    })) as number;

    try {
      const [roundId, answer, , updatedAt, answeredInRound] = (await client.readContract({
        address: feed,
        abi: FEED_ABI,
        functionName: 'latestRoundData',
        args: [],
      })) as [bigint, bigint, bigint, bigint, bigint];

      const now = BigInt(Math.floor(Date.now() / 1000));
      const ttlSeconds = BigInt(Math.max(1, Math.floor(ORACLE_TTL_MS / 1000)));
      const stale =
        answer <= 0n ||
        updatedAt === 0n ||
        now - updatedAt > ttlSeconds ||
        answeredInRound < roundId;

      const priceUsd = stale ? null : Number(answer) / 10 ** decimals;

      return {
        feed,
        priceUsd,
        decimals,
        updatedAt: Number(updatedAt),
        stale,
        rawAnswer: answer.toString(),
        answeredInRound: answeredInRound.toString(),
      };
    } catch (roundDataErr) {
      // Some feeds on L2 only expose the legacy AggregatorV2 interface (latestAnswer/latestTimestamp).
      try {
        const answer = (await client.readContract({
          address: feed,
          abi: LEGACY_FEED_ABI,
          functionName: 'latestAnswer',
          args: [],
        })) as bigint;

        let updatedAt: bigint;
        let legacyError: string | undefined;
        try {
          updatedAt = (await client.readContract({
            address: feed,
            abi: LEGACY_FEED_ABI,
            functionName: 'latestTimestamp',
            args: [],
          })) as bigint;
        } catch (tsErr) {
          legacyError = tsErr instanceof Error ? tsErr.message : String(tsErr);
          updatedAt = BigInt(Math.floor(Date.now() / 1000));
        }

        const now = BigInt(Math.floor(Date.now() / 1000));
        const ttlSeconds = BigInt(Math.max(1, Math.floor(ORACLE_TTL_MS / 1000)));
        const stale = answer <= 0n || updatedAt === 0n || now - updatedAt > ttlSeconds;
        const priceUsd = stale ? null : Number(answer) / 10 ** decimals;

        return {
          feed,
          priceUsd,
          decimals,
          updatedAt: Number(updatedAt),
          stale,
          rawAnswer: answer.toString(),
          answeredInRound: 'legacy',
          error:
            legacyError ?? (roundDataErr instanceof Error ? roundDataErr.message : String(roundDataErr)),
        };
      } catch (legacyErr) {
        return {
          feed,
          priceUsd: null,
          decimals,
          updatedAt: null,
          stale: true,
          error: legacyErr instanceof Error ? legacyErr.message : String(legacyErr),
        };
      }
    }
  } catch (err) {
    return {
      feed,
      priceUsd: null,
      decimals: null,
      updatedAt: null,
      stale: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function cachedOracleDetail(client: RpcClient, token: TokenInfo): Promise<OracleObservation> {
  if (!token.chainlinkFeed) {
    return {
      feed: token.chainlinkFeed ?? null,
      priceUsd: null,
      decimals: null,
      updatedAt: null,
      stale: true,
      error: 'missing-feed',
    };
  }

  const key = cacheKeyOracle(token)!;
  const now = Date.now();
  const entry = oracleCache.get(key);
  if (entry && entry.expires > now && entry.pending === undefined && entry.value) {
    return entry.value;
  }
  if (entry?.pending) {
    return entry.pending;
  }
  const pending: Promise<OracleObservation> = loadOracleDetail(client, token).then((value) => {
    const existing = oracleCache.get(key);
    const isValueUsable = value.priceUsd != null && value.decimals != null && !value.stale;
    const existingUsable = existing?.value?.priceUsd != null && existing.value.decimals != null && existing.value.stale === false;
  const nextValue: OracleObservation = isValueUsable ? value : existingUsable ? existing!.value! : value;
    const ttl = isValueUsable ? ORACLE_TTL_MS : ORACLE_ERROR_RETRY_MS;
    if (!isValueUsable && existingUsable && value.error) {
      log.debug({
        feed: token.chainlinkFeed,
        error: value.error,
      }, 'oracle-fetch-error-using-cached');
    }
    oracleCache.set(key, { value: nextValue, expires: Date.now() + ttl });
    return nextValue;
  });
  oracleCache.set(key, { value: entry?.value, expires: entry?.expires ?? 0, pending });
  return pending;
}

async function cachedOraclePrice(client: RpcClient, token: TokenInfo, chain?: ChainCfg): Promise<number | undefined> {
  const detail = await cachedOracleDetail(client, token);
  const guardKey = `${chain?.id ?? 0}:${token.address.toLowerCase()}`;
  if (detail.priceUsd === null) {
    if (chain) {
      const dexPrice = await dexFallbackPrice(client, chain, token);
      if (dexPrice !== undefined) {
        return applyVolatilityGuard(guardKey, dexPrice);
      }
      if (detail.error) {
        log.debug({
          chainId: chain.id,
          symbol: token.address,
          feed: token.chainlinkFeed,
          error: detail.error,
          stale: detail.stale,
          updatedAt: detail.updatedAt,
        }, 'oracle-price-null');
      }
    }
    return undefined;
  }

  // If feed is ETH-denominated, convert to USD
  if (token.feedDenomination === 'eth' && chain) {
    const wethToken = Object.values(chain.tokens).find(t =>
      t.address.toLowerCase() === chain.tokens.WETH?.address.toLowerCase()
    );
    if (wethToken?.chainlinkFeed) {
      const ethUsdPrice = await cachedOraclePrice(client, wethToken, chain);
      if (ethUsdPrice !== undefined && ethUsdPrice > 0) {
        const convertedPrice = detail.priceUsd * ethUsdPrice;
        log.debug({
          chainId: chain.id,
          symbol: token.address,
          ethPrice: detail.priceUsd,
          ethUsdPrice,
          convertedUsd: convertedPrice,
        }, 'eth-denomination-converted');
        return applyVolatilityGuard(guardKey, convertedPrice);
      }
    }
    // If we can't get ETH/USD price, return undefined to avoid using stale ETH-denominated price
    log.debug({ chainId: chain.id, symbol: token.address }, 'eth-denomination-no-eth-usd');
    return undefined;
  }

  return applyVolatilityGuard(guardKey, detail.priceUsd);
}

async function cachedBestRoute(params: {
  client: RpcClient;
  chain: ChainCfg;
  collateral: TokenInfo;
  debt: TokenInfo;
  unitIn: bigint;
  routeOptions?: RouteOption[];
}): Promise<Awaited<ReturnType<typeof bestRoute>> | undefined> {
  const { client, chain, collateral, debt, unitIn, routeOptions } = params;
  const cfg = getCachedConfig();
  const contractAddr = cfg.contracts?.liquidator?.[chain.id] as Address | undefined;
  if (!contractAddr) return undefined;
  const key = cacheKeyRoute(chain, collateral, debt, routeOptions);
  const now = Date.now();
  const entry = routeCache.get(key);
  if (entry && entry.expires > now && entry.pending === undefined) {
    return entry.value;
  }
  if (entry?.pending) {
    return entry.pending;
  }
  let options: RouteOption[] | undefined = routeOptions;
  if (!options || options.length === 0) {
    const collateralSymbol = findTokenSymbol(chain, collateral);
    const debtSymbol = findTokenSymbol(chain, debt);
    if (collateralSymbol && debtSymbol) {
      try {
        const built = buildRouteOptions(cfg, chain, debtSymbol, collateralSymbol);
        options = built.options;
      } catch (err) {
        log.debug(
          {
            chainId: chain.id,
            collateral: collateralSymbol,
            debt: debtSymbol,
            err: err instanceof Error ? err.message : String(err),
          },
          'route-options-build-failed',
        );
      }
    }
  }
  if (!options || options.length === 0) {
    const routerAddr = chain.uniV3Router;
    if (!routerAddr) return undefined;
    options = [{ type: 'UniV3', router: routerAddr as Address, fee: 500 }];
  }
  const pending = bestRoute({
    client,
    chain,
    contract: contractAddr,
    collateral,
    debt,
    seizeAmount: unitIn,
    slippageBps: 0,
    options,
  })
    .then((value) => {
      routeCache.set(key, { value, expires: Date.now() + ROUTE_TTL_MS });
      return value;
    })
    .catch((err) => {
      log.debug(
        {
          chainId: chain.id,
          collateral: collateral.address,
          debt: debt.address,
          err: err instanceof Error ? err.message : String(err),
        },
        'route-cache-miss'
      );
      routeCache.set(key, { value: undefined, expires: Date.now() + ROUTE_ERROR_TTL_MS });
      return undefined;
    });
  routeCache.set(key, { value: entry?.value, expires: entry?.expires ?? 0, pending });
  return pending;
}

// Minimal AggregatorV3Interface ABI (Chainlink)
const FEED_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { internalType: 'uint80', name: 'roundId', type: 'uint80' },
      { internalType: 'int256', name: 'answer', type: 'int256' },
      { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
      { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
      { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

const LEGACY_FEED_ABI = [
  {
    type: 'function',
    name: 'latestAnswer',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ internalType: 'int256', name: '', type: 'int256' }],
  },
  {
    type: 'function',
    name: 'latestTimestamp',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
  },
] as const;

function toNumber(amount: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const integer = amount / base;
  const fraction = amount % base;
  return Number(integer) + Number(fraction) / Number(base);
}

const PRICE_JUMP_THRESHOLD = Number(process.env.PRICE_JUMP_THRESHOLD ?? 10); // 1000% change
const PRICE_JUMP_WINDOW_MS = Number(process.env.PRICE_JUMP_WINDOW_MS ?? 60_000);
const priceHistory = new Map<string, { price: number; timestamp: number }>();

function applyVolatilityGuard(key: string, price: number): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  const now = Date.now();
  const last = priceHistory.get(key);
  if (last) {
    const change = Math.abs(price / last.price - 1);
    if (change > PRICE_JUMP_THRESHOLD && now - last.timestamp < PRICE_JUMP_WINDOW_MS) {
      log.warn(
        {
          key,
          previous: last.price,
          incoming: price,
          change,
          windowMs: now - last.timestamp,
        },
        'price-volatility-rejected',
      );
      return last.price;
    }
  }
  priceHistory.set(key, { price, timestamp: now });
  return price;
}

export async function oraclePriceUsd(client: RpcClient, token: TokenInfo, chain?: ChainCfg): Promise<number | undefined> {
  return cachedOraclePrice(client, token, chain);
}

export async function oraclePriceDetails(client: RpcClient, token: TokenInfo): Promise<OraclePriceDetail> {
  const observation = await cachedOracleDetail(client, token);
  const updatedAt = observation.updatedAt;
  const ageSeconds = updatedAt ? Math.max(0, Math.floor(Date.now() / 1000) - updatedAt) : null;
  return {
    ...observation,
    ageSeconds,
    hasFeed: Boolean(observation.feed ?? token.chainlinkFeed),
  };
}

async function dexFallbackPrice(client: RpcClient, chain: ChainCfg, token: TokenInfo): Promise<number | undefined> {
  const tokenSymbol = findTokenSymbol(chain, token);
  if (!tokenSymbol) return undefined;

  const cfg = getCachedConfig();
  for (const stableSymbol of preferredStableSymbols(chain)) {
    if (stableSymbol === tokenSymbol) continue;
    const stableToken = chain.tokens?.[stableSymbol];
    if (!stableToken) continue;
    if (stableToken.address?.toLowerCase() === token.address.toLowerCase()) continue;

    const { options } = buildRouteOptions(cfg, chain, stableSymbol, tokenSymbol);
    if (!options || options.length === 0) continue;

    const ratio = await dexPriceRatio({
      client,
      chain,
      collateral: token,
      debt: stableToken,
      routeOptions: options,
    });
    if (!ratio || ratio <= 0) continue;

    const basePrice = await cachedOraclePrice(client, stableToken, chain);
    if (basePrice === undefined || basePrice <= 0) continue;

    const price = ratio * basePrice;
    log.debug(
      {
        chainId: chain.id,
        symbol: tokenSymbol,
        base: stableSymbol,
        ratio,
        price,
      },
      'dex-fallback-price',
    );
    return price;
  }

  return undefined;
}

export async function oracleDexGapBps({
  client,
  chain,
  collateral,
  debt,
  routeOptions,
}: {
  client: RpcClient;
  chain: ChainCfg;
  collateral: TokenInfo;
  debt: TokenInfo;
  routeOptions?: RouteOption[];
}): Promise<number> {
  const collateralPriceUsd = await cachedOraclePrice(client, collateral, chain);
  const debtPriceUsd = (await cachedOraclePrice(client, debt, chain)) ?? 1;

  const oraclePrice = collateralPriceUsd !== undefined ? collateralPriceUsd / debtPriceUsd : undefined;

  const unitIn = 10n ** BigInt(Math.min(collateral.decimals, 18));
  const route = await cachedBestRoute({ client, chain, collateral, debt, routeOptions, unitIn });
  if (!route) return 0;

  const dexPrice = toNumber(route.quotedOut, debt.decimals) / toNumber(unitIn, collateral.decimals);

  if (!oraclePrice || oraclePrice === 0) {
    return 0;
  }

  const diff = Math.abs(dexPrice - oraclePrice);
  return Math.round((diff / oraclePrice) * 10_000);
}

// Returns the DEX price ratio (collateral/debt), if available.
// Useful as a TWAP-like fallback when an oracle price is temporarily missing.
export async function dexPriceRatio({
  client,
  chain,
  collateral,
  debt,
  routeOptions,
}: {
  client: RpcClient;
  chain: ChainCfg;
  collateral: TokenInfo;
  debt: TokenInfo;
  routeOptions?: RouteOption[];
}): Promise<number | undefined> {
  const unitIn = 10n ** BigInt(Math.min(collateral.decimals, 18));
  const route = await cachedBestRoute({ client, chain, collateral, debt, routeOptions, unitIn });
  if (!route) return undefined;
  const dexPrice = toNumber(route.quotedOut, debt.decimals) / toNumber(unitIn, collateral.decimals);
  if (!Number.isFinite(dexPrice) || dexPrice <= 0) return undefined;
  return dexPrice;
}
