import type { Address, Chain, PublicClient, Transport } from 'viem';
import { ChainCfg, TokenInfo } from '../infra/config';
import { bestRoute, RouteOption } from '../simulator/router';

type RpcClient = PublicClient<Transport, Chain | undefined, any>;

const ORACLE_TTL_MS = 15_000;
const ROUTE_TTL_MS = 5_000;

type OracleDetail = {
  priceUsd?: number;
  updatedAt?: number;
  decimals?: number;
  stale: boolean;
};

type OracleCacheEntry = {
  value: OracleDetail | undefined;
  expires: number;
  pending?: Promise<OracleDetail | undefined>;
};

type RouteCacheEntry = {
  value: Awaited<ReturnType<typeof bestRoute>> | undefined;
  expires: number;
  pending?: Promise<Awaited<ReturnType<typeof bestRoute>> | undefined>;
};

const oracleCache = new Map<string, OracleCacheEntry>();
const routeCache = new Map<string, RouteCacheEntry>();

function cacheKeyOracle(token: TokenInfo): string | undefined {
  if (!token.chainlinkFeed) return undefined;
  return token.chainlinkFeed.toLowerCase();
}

function cacheKeyRoute(chain: ChainCfg, collateral: TokenInfo, debt: TokenInfo, router: string, fee: number): string {
  return `${chain.id}:${router.toLowerCase()}:${collateral.address.toLowerCase()}:${debt.address.toLowerCase()}:${fee}`;
}

async function loadOracleDetail(client: RpcClient, token: TokenInfo): Promise<OracleDetail | undefined> {
  if (!token.chainlinkFeed) return { stale: true };
  try {
    const decimals = (await client.readContract({
      address: token.chainlinkFeed,
      abi: FEED_ABI,
      functionName: 'decimals',
      args: [],
    })) as number;

    const result = (await client.readContract({
      address: token.chainlinkFeed,
      abi: FEED_ABI,
      functionName: 'latestRoundData',
      args: [],
    })) as [bigint, bigint, bigint, bigint, bigint];

    const answer = result[1];
    const updatedAt = result[3];
    const now = BigInt(Math.floor(Date.now() / 1000));
    const stale = answer <= 0n || updatedAt === 0n || now - updatedAt > BigInt(ORACLE_TTL_MS / 1000);
    return {
      priceUsd: stale ? undefined : Number(answer) / 10 ** decimals,
      updatedAt: Number(updatedAt),
      decimals,
      stale,
    };
  } catch (_err) {
    return { stale: true };
  }
}

async function cachedOracleDetail(client: RpcClient, token: TokenInfo): Promise<OracleDetail | undefined> {
  const key = cacheKeyOracle(token);
  if (!key) return undefined;
  const now = Date.now();
  const entry = oracleCache.get(key);
  if (entry && entry.expires > now && entry.pending === undefined) {
    return entry.value;
  }
  if (entry?.pending) {
    return entry.pending;
  }
  const pending = loadOracleDetail(client, token).then((value) => {
    oracleCache.set(key, { value, expires: Date.now() + ORACLE_TTL_MS });
    return value;
  });
  oracleCache.set(key, { value: entry?.value, expires: entry?.expires ?? 0, pending });
  return pending;
}

async function cachedBestRoute(params: {
  client: RpcClient;
  chain: ChainCfg;
  collateral: TokenInfo;
  debt: TokenInfo;
  fee: number;
  router?: string;
  unitIn: bigint;
}): Promise<Awaited<ReturnType<typeof bestRoute>> | undefined> {
  const { client, chain, collateral, debt, fee, router, unitIn } = params;
  const routerAddr = router ?? chain.uniV3Router;
  if (!routerAddr) return undefined;
  const key = cacheKeyRoute(chain, collateral, debt, routerAddr, fee);
  const now = Date.now();
  const entry = routeCache.get(key);
  if (entry && entry.expires > now && entry.pending === undefined) {
    return entry.value;
  }
  if (entry?.pending) {
    return entry.pending;
  }
  const options: RouteOption[] = [
    { type: 'UniV3', router: routerAddr as Address, fee },
  ];
  const pending = bestRoute({
    client,
    chain,
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
    .catch(() => {
      routeCache.delete(key);
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

function toNumber(amount: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const integer = amount / base;
  const fraction = amount % base;
  return Number(integer) + Number(fraction) / Number(base);
}

export async function oraclePriceUsd(client: RpcClient, token: TokenInfo): Promise<number | undefined> {
  const detail = await cachedOracleDetail(client, token);
  return detail?.priceUsd;
}

export async function oraclePriceDetails(client: RpcClient, token: TokenInfo) {
  const detail = await cachedOracleDetail(client, token);
  if (!detail) {
    return {
      priceUsd: undefined,
      updatedAt: undefined,
      ageSeconds: undefined,
      stale: true,
      hasFeed: Boolean(token.chainlinkFeed),
    };
  }
  const updatedAt = detail.updatedAt ? Number(detail.updatedAt) : undefined;
  const ageSeconds = updatedAt ? Math.max(0, Math.floor(Date.now() / 1000) - updatedAt) : undefined;
  return {
    priceUsd: detail.priceUsd,
    updatedAt,
    ageSeconds,
    stale: detail.stale,
    decimals: detail.decimals,
    hasFeed: Boolean(token.chainlinkFeed),
  };
}

export async function oracleDexGapBps({
  client,
  chain,
  collateral,
  debt,
  fee,
  router,
}: {
  client: RpcClient;
  chain: ChainCfg;
  collateral: TokenInfo;
  debt: TokenInfo;
  fee: number;
  router?: string;
}): Promise<number> {
  const collateralDetail = await cachedOracleDetail(client, collateral);
  const debtDetail = await cachedOracleDetail(client, debt);
  const collateralPriceUsd = collateralDetail?.priceUsd;
  const debtPriceUsd = debtDetail?.priceUsd ?? 1;

  const oraclePrice = collateralPriceUsd !== undefined ? collateralPriceUsd / debtPriceUsd : undefined;

  const unitIn = 10n ** BigInt(Math.min(collateral.decimals, 18));
  const route = await cachedBestRoute({ client, chain, collateral, debt, fee, router, unitIn });
  if (!route) return 0;

  const dexPrice = toNumber(route.quotedOut, debt.decimals) / toNumber(unitIn, collateral.decimals);

  if (!oraclePrice || oraclePrice === 0) {
    return 0;
  }

  const diff = Math.abs(dexPrice - oraclePrice);
  return Math.round((diff / oraclePrice) * 10_000);
}
