import '../infra/env';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { createPublicClient, http, PublicClient } from 'viem';
import { Address } from 'viem';
import { loadConfig, type AppConfig, type ChainCfg } from '../infra/config';
import { AaveV3Arbitrum, AaveV3Optimism, AaveV3Base, AaveV3Polygon } from '@bgd-labs/aave-address-book';

const CONFIG_PATH = path.resolve(__dirname, '../../config.yaml');
const CONFIG_FILE_RELATIVE = 'config.yaml';

const CHAIN_MODULES: Record<number, { assets: Record<string, any> | undefined }> = {
  42161: { assets: AaveV3Arbitrum.ASSETS as Record<string, any> | undefined },
  10: { assets: AaveV3Optimism.ASSETS as Record<string, any> | undefined },
  8453: { assets: AaveV3Base.ASSETS as Record<string, any> | undefined },
  137: { assets: AaveV3Polygon.ASSETS as Record<string, any> | undefined },
};

const SYMBOL_OVERRIDES: Record<string, string> = {
  EURS: 'EURS',
  USDCn: 'USDCn',
  WSTETH: 'wstETH',
  WEETH: 'weETH',
  RETH: 'rETH',
};

const FEED_OVERRIDES: Record<number, Record<string, string>> = {
  137: {
    USDT: '0x0A6513e40db6EB1b165753AD52E80663aeA50545',
  },
};

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'LUSD', 'SUSD', 'FRAX', 'USDCN', 'MAI', 'USDS', 'USDBC', 'EURS']);
const LSTS = new Set(['WSTETH', 'STETH', 'WEETH', 'RETH', 'MATICX', 'STMATIC', 'CBETH', 'ANKRETH']);
const MAJORS = new Set(['WETH', 'WBTC', 'WMATIC', 'WPOL', 'ARB']);

const GOVERNANCE = new Set(['AAVE', 'LINK', 'OP', 'BAL', 'CRV', 'GHST', 'SUSHI', 'DPI']);

const DEFAULT_POLICIES: Record<'stable' | 'lst' | 'major' | 'governance' | 'other', { floorBps: number; gapCapBps: number; slippageBps: number }> = {
  stable: { floorBps: 30, gapCapBps: 50, slippageBps: 50 },
  lst: { floorBps: 30, gapCapBps: 70, slippageBps: 30 },
  major: { floorBps: 30, gapCapBps: 60, slippageBps: 30 },
  governance: { floorBps: 40, gapCapBps: 90, slippageBps: 40 },
  other: { floorBps: 50, gapCapBps: 110, slippageBps: 60 },
};

const ERC20_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

const clientCache = new Map<string, PublicClient>();

const DEFAULT_DENY_ASSETS: string[] = [];
const AUTO_ALLOW_ASSETS = ['ARB', 'FRAX', 'MAI', 'EURS', 'GHO'];

const DATA_PROVIDER_ADDRESSES: Record<number, string | undefined> = {
  42161: AaveV3Arbitrum.AAVE_PROTOCOL_DATA_PROVIDER,
  10: AaveV3Optimism.AAVE_PROTOCOL_DATA_PROVIDER,
  8453: AaveV3Base.AAVE_PROTOCOL_DATA_PROVIDER,
  137: AaveV3Polygon.AAVE_PROTOCOL_DATA_PROVIDER,
};

const DATA_PROVIDER_ABI = [
  {
    type: 'function',
    name: 'getAllReservesTokens',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        components: [
          { name: 'symbol', type: 'string' },
          { name: 'tokenAddress', type: 'address' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'getReserveConfigurationData',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [
      { name: 'decimals', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'liquidationThreshold', type: 'uint256' },
      { name: 'liquidationBonus', type: 'uint256' },
      { name: 'reserveFactor', type: 'uint256' },
      { name: 'usageAsCollateralEnabled', type: 'bool' },
      { name: 'borrowingEnabled', type: 'bool' },
      { name: 'stableBorrowRateEnabled', type: 'bool' },
      { name: 'isActive', type: 'bool' },
      { name: 'isFrozen', type: 'bool' },
    ],
  },
] as const;

type ReserveConfig = {
  symbol: string;
  address: string;
  borrowable: boolean;
  collateral: boolean;
  liquidationBonusBps: number | null;
};

function clampBonus(bonus: number | null | undefined): number {
  if (bonus == null || Number.isNaN(bonus)) return 800;
  return Math.max(0, Math.min(3000, Math.round(bonus)));
}

async function fetchReserveConfigs(chain: ChainCfg, rpcUrl: string): Promise<Map<string, ReserveConfig>> {
  const providerAddress = DATA_PROVIDER_ADDRESSES[chain.id];
  if (!providerAddress) {
    return new Map();
  }

  const client = getClient(rpcUrl);
  let reserves: Array<{ symbol: string; tokenAddress: string }> = [];
  try {
    reserves = (await client.readContract({
      address: providerAddress as Address,
      abi: DATA_PROVIDER_ABI,
      functionName: 'getAllReservesTokens',
    })) as Array<{ symbol: string; tokenAddress: string }>;
  } catch (err) {
    console.warn(`Unable to fetch reserves for chain ${chain.id}: ${(err as Error).message}`);
    return new Map();
  }

  const out = new Map<string, ReserveConfig>();
  for (const reserve of reserves) {
    let config:
      | [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]
      | null = null;
    try {
      config = (await client.readContract({
        address: providerAddress as Address,
        abi: DATA_PROVIDER_ABI,
        functionName: 'getReserveConfigurationData',
        args: [reserve.tokenAddress as Address],
      })) as [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean];
    } catch (err) {
      console.warn(`failed to fetch reserve config for ${reserve.symbol} on chain ${chain.id}: ${(err as Error).message}`);
      continue;
    }
    if (!config) continue;
    const [
      ,
      ,
      ,
      liquidationBonus,
      ,
      usageAsCollateralEnabled,
      borrowingEnabled,
      ,
      isActive,
      isFrozen,
    ] = config;
    if (!isActive || isFrozen) continue;
    const normalized = normalizeSymbol(reserve.symbol);
    const bonusBps = Number(liquidationBonus) - 10_000;
    out.set(normalized, {
      symbol: normalized,
      address: reserve.tokenAddress,
      borrowable: borrowingEnabled,
      collateral: usageAsCollateralEnabled,
      liquidationBonusBps: bonusBps,
    });
  }

  return out;
}

function sortMarkets(markets: any[]): any[] {
  return markets.sort((a, b) => {
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    if (a.debtAsset !== b.debtAsset) return a.debtAsset.localeCompare(b.debtAsset);
    return a.collateralAsset.localeCompare(b.collateralAsset);
  });
}

async function buildMarkets(cfg: any, resolved: AppConfig): Promise<any[]> {
  const markets: any[] = [];
  const deny = new Set<string>(cfg.risk?.denyAssets ?? []);

  for (const chain of cfg.chains ?? []) {
    const resolvedChain = resolved.chains.find((c) => c.id === chain.id);
    const rpcUrl = resolvedChain?.rpc ?? chain.rpc;
    if (typeof rpcUrl !== 'string' || rpcUrl.includes('${')) {
      console.warn(`Skipping market expansion for chain ${chain.id}; unresolved RPC URL.`);
      continue;
    }
    const reserveConfigs = await fetchReserveConfigs(chain, rpcUrl).catch(() => new Map());
    // Only consider symbols that are both priced (have feed) and are active Aave reserves
    const symbolSet = new Set<string>();
    const reserveSymbols = new Set<string>(Array.from(reserveConfigs.keys()));
    const tokenEntries = Object.entries(chain.tokens ?? {}) as Array<[
      string,
      { chainlinkFeed?: string | null }
    ]>;
    for (const [symbol, token] of tokenEntries) {
      if (!token.chainlinkFeed) continue;
      if (!reserveSymbols.has(symbol)) continue;
      symbolSet.add(symbol);
    }
    const symbols = Array.from(symbolSet).sort((a, b) => a.localeCompare(b));
    for (const debtSymbol of symbols) {
      if (deny.has(debtSymbol)) continue;
      const debtConfig = reserveConfigs.get(debtSymbol);
      if (debtConfig && !debtConfig.borrowable) continue;
      for (const collateralSymbol of symbols) {
        if (debtSymbol === collateralSymbol) continue;
        if (deny.has(collateralSymbol)) continue;
        const collateralConfig = reserveConfigs.get(collateralSymbol);
        if (collateralConfig && !collateralConfig.collateral) continue;
        const bonusBps = collateralConfig?.liquidationBonusBps ?? null;
        markets.push({
          protocol: 'aavev3',
          chainId: chain.id,
          debtAsset: debtSymbol,
          collateralAsset: collateralSymbol,
          closeFactorBps: 5000,
          bonusBps: clampBonus(bonusBps),
          enabled: Boolean(chain.enabled) && (debtConfig?.borrowable ?? true) && (collateralConfig?.collateral ?? true),
        });
      }
    }
  }

  return sortMarkets(markets);
}

function getClient(rpcUrl: string): PublicClient {
  let client = clientCache.get(rpcUrl);
  if (!client) {
    client = createPublicClient({ transport: http(rpcUrl) });
    clientCache.set(rpcUrl, client);
  }
  return client;
}

type TokenInfo = {
  address: string;
  decimals: number;
  chainlinkFeed?: string;
  feedDenomination?: 'usd' | 'eth';
};

const MANUAL_TOKENS: Record<number, Record<string, TokenInfo>> = {
  42161: {
    GHO: {
      address: '0x7dff72693f6a4149b17e7c6314655f6a9f7c8b33',
      decimals: 18,
      chainlinkFeed: '0xB05984aD83C20b3ADE7bf97a9a0Cb539DDE28DBb',
    },
    ezETH: {
      address: '0x2416092f143378750bb29b79ed961ab195cceea5',
      decimals: 18,
    },
    rsETH: {
      address: '0x4186bfc76e2e237523cbc30fd220fe055156b41f',
      decimals: 18,
      chainlinkFeed: '0xb0EA543f9F8d4B818550365d13F66Da747e1476A',
      feedDenomination: 'eth',
    },
  },
  8453: {
    GHO: {
      address: '0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee',
      decimals: 18,
    },
    weETH: {
      address: '0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A',
      decimals: 18,
      chainlinkFeed: '0xFc4d1d7a8FD1E6719e361e16044b460737F12C44',
    },
  },
  137: {
    WPOL: {
      address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
      decimals: 18,
      chainlinkFeed: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
    },
  },
};

type AssetPolicy = {
  floorBps: number;
  gapCapBps: number;
  slippageBps: number;
};

function normalizeSymbol(raw: string): string {
  const override = SYMBOL_OVERRIDES[raw];
  return override ?? raw;
}

function classify(symbol: string): keyof typeof DEFAULT_POLICIES {
  const norm = symbol.toUpperCase();
  if (STABLES.has(norm)) return 'stable';
  if (LSTS.has(norm)) return 'lst';
  if (MAJORS.has(norm)) return 'major';
  if (GOVERNANCE.has(norm)) return 'governance';
  return 'other';
}

function sortObject<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchDecimals(rpcUrl: string, token: string, fallback?: number): Promise<number> {
  try {
    const client = getClient(rpcUrl);
    const decimals = await client.readContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    return Number(decimals);
  } catch (err) {
    if (fallback != null) {
      return fallback;
    }
    console.warn(`Unable to fetch decimals for ${token} via ${rpcUrl}: ${(err as Error).message}`);
    return 18;
  }
}

async function buildTokenMap(chainId: number, rpcUrl: string, existing: Record<string, TokenInfo>): Promise<Record<string, TokenInfo>> {
  const mod = CHAIN_MODULES[chainId];
  if (!mod?.assets) {
    return existing;
  }

  // Only include tokens that are Aave reserves (plus manual tokens). We do not carry over arbitrary existing tokens
  // to avoid stale/misconfigured symbols (e.g., non-contract addresses like USR/wBTC on Base).
  const existingEntries = new Map<string, TokenInfo>(Object.entries(existing ?? {}));
  const tokens = new Map<string, TokenInfo>();
  const entries = Object.entries(mod.assets ?? {});

  for (const [rawSymbol, assetData] of entries) {
    if (!assetData) continue;
    const derivedSymbol = normalizeSymbol(rawSymbol);
    const underlying = assetData.UNDERLYING ?? assetData.underlying ?? assetData.tokenAddress;
    const oracle = assetData.ORACLE ?? assetData.oracle ?? assetData.priceOracle;
    const declaredDecimals = assetData.decimals ?? assetData.DECIMALS;
    if (!underlying) continue;

    let targetSymbol = derivedSymbol;
    const current = tokens.get(targetSymbol);
    let aliasSymbol: string | undefined;
    let aliasInfo: TokenInfo | undefined;

    if (!current) {
      // search in existing entries (not the building map) to reuse metadata if addresses match
      for (const [existingSymbol, info] of existingEntries.entries()) {
        if (info.address?.toLowerCase() === underlying.toLowerCase()) {
          aliasSymbol = existingSymbol;
          aliasInfo = info;
          break;
        }
      }
    }

    const decimals = await fetchDecimals(rpcUrl, underlying, declaredDecimals ?? current?.decimals);
    const tokenInfo: TokenInfo = {
      address: underlying,
      decimals,
    };
    const overrideFeed = FEED_OVERRIDES[chainId]?.[targetSymbol];
    const feedAddress = overrideFeed ?? oracle;
    if (feedAddress && feedAddress !== '0x0000000000000000000000000000000000000000') {
      tokenInfo.chainlinkFeed = feedAddress;
    } else {
      const inheritedFeed = current?.chainlinkFeed ?? aliasInfo?.chainlinkFeed;
      if (inheritedFeed) {
        tokenInfo.chainlinkFeed = inheritedFeed;
      }
    }

    const merged = { ...(aliasInfo ?? {}), ...(current ?? {}), ...tokenInfo };
    tokens.set(targetSymbol, { ...merged });
    if (aliasSymbol && aliasSymbol !== targetSymbol) {
      tokens.set(aliasSymbol, { ...(aliasInfo ?? {}), ...tokenInfo });
    }
  }

  const manualTokens = MANUAL_TOKENS[chainId];
  if (manualTokens) {
    for (const [symbol, info] of Object.entries(manualTokens)) {
      tokens.set(symbol, { ...info });
    }
  }

  return sortObject(Object.fromEntries(tokens.entries()));
}

function mergeAssetPolicies(existing: Record<string, AssetPolicy>, symbols: Iterable<string>): Record<string, AssetPolicy> {
  const deduped = new Map<string, AssetPolicy>();
  for (const [symbol, policy] of Object.entries(existing ?? {})) {
    if (!deduped.has(symbol)) {
      deduped.set(symbol, policy);
    }
  }
  for (const symbol of symbols) {
    if (!deduped.has(symbol)) {
      const preset = DEFAULT_POLICIES[classify(symbol)];
      deduped.set(symbol, { ...preset });
    }
  }
  return sortObject(Object.fromEntries(deduped.entries()));
}

async function main() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.yaml not found at ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = YAML.parse(raw);
  const resolved: AppConfig = loadConfig(CONFIG_FILE_RELATIVE);

  if (!cfg.chains) {
    throw new Error('config.yaml missing chains block');
  }

  const originalMeta = new Map<number, { wsRpc?: string; privtx?: string }>();
  for (const chain of cfg.chains ?? []) {
    originalMeta.set(chain.id, { wsRpc: chain.wsRpc, privtx: chain.privtx });
  }

  for (const chain of cfg.chains) {
    if (!CHAIN_MODULES[chain.id]) continue;
    const resolvedChain = resolved.chains.find((c) => c.id === chain.id);
    const rpcUrl = resolvedChain?.rpc ?? chain.rpc;
    if (typeof rpcUrl !== 'string' || rpcUrl.includes('${')) {
      console.warn(`Skipping chain ${chain.name} (id ${chain.id}) because rpc URL is unresolved.`);
      continue;
    }
    const existingTokens: Record<string, TokenInfo> = chain.tokens ?? {};
    chain.tokens = await buildTokenMap(chain.id, rpcUrl, existingTokens);
    const original = originalMeta.get(chain.id);
    if (original) {
      chain.wsRpc = original.wsRpc ?? chain.wsRpc;
      chain.privtx = original.privtx ?? chain.privtx;
    }
  }

  const allSymbols = new Set<string>();
  for (const chain of cfg.chains) {
    Object.keys(chain.tokens ?? {}).forEach((s) => allSymbols.add(s));
    if (Array.isArray(chain.extraTokens)) {
      chain.extraTokens.forEach((s: string) => allSymbols.add(s));
    }
  }
  for (const market of cfg.markets ?? []) {
    if (market.debtAsset) allSymbols.add(normalizeSymbol(market.debtAsset));
    if (market.collateralAsset) allSymbols.add(normalizeSymbol(market.collateralAsset));
  }

  cfg.assets = mergeAssetPolicies(cfg.assets ?? {}, allSymbols);

  const denyAssets = new Set<string>();
  for (const symbol of AUTO_ALLOW_ASSETS) {
    denyAssets.delete(symbol);
  }
  for (const symbol of DEFAULT_DENY_ASSETS) {
    denyAssets.add(symbol);
  }
  if (!cfg.risk) cfg.risk = {};
  cfg.risk.denyAssets = Array.from(denyAssets).sort();

  cfg.risk.gasCapUsd = Math.max(cfg.risk.gasCapUsd ?? 0, 15);
  cfg.risk.pnlPerGasMin = Math.min(cfg.risk.pnlPerGasMin ?? 1.2, 1.2);
  cfg.risk.maxRepayUsd = Math.max(cfg.risk.maxRepayUsd ?? 0, 5000);
  cfg.risk.maxSessionNotionalUsd = Math.max(cfg.risk.maxSessionNotionalUsd ?? 0, 20000);
  cfg.risk.healthFactorMax = Math.max(cfg.risk.healthFactorMax ?? 0, 0.985);

  if (!cfg.indexer) cfg.indexer = {};
  cfg.indexer.hfThreshold = Math.min(cfg.indexer.hfThreshold ?? 1.05, 1.02);

  const expandedMarkets = await buildMarkets(cfg, resolved);
  if (expandedMarkets.length > 0) {
    cfg.markets = expandedMarkets;
  }

  fs.writeFileSync(CONFIG_PATH, YAML.stringify(cfg, { lineWidth: 0 }));
  console.log('config.yaml updated: tokens and policies synced with Aave address book.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
