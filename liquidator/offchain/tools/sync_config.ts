import '../infra/env';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { createPublicClient, http, PublicClient } from 'viem';
import { Address } from 'viem';
import {
  AaveV3ArbitrumAssets,
  AaveV3OptimismAssets,
  AaveV3BaseAssets,
  AaveV3PolygonAssets,
} from '@bgd-labs/aave-address-book';
import { loadConfig, type AppConfig } from '../infra/config';

const CONFIG_PATH = path.resolve(__dirname, '../../config.yaml');
const CONFIG_FILE_RELATIVE = 'config.yaml';

const CHAIN_MODULES: Record<number, { assets: Record<string, any>; prefix: string }> = {
  42161: { assets: AaveV3ArbitrumAssets, prefix: 'AaveV3ArbitrumAssets_' },
  10: { assets: AaveV3OptimismAssets, prefix: 'AaveV3OptimismAssets_' },
  8453: { assets: AaveV3BaseAssets, prefix: 'AaveV3BaseAssets_' },
  137: { assets: AaveV3PolygonAssets, prefix: 'AaveV3PolygonAssets_' },
};

const SYMBOL_OVERRIDES: Record<string, string> = {
  WPOL: 'WMATIC',
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

const DEFAULT_DENY_ASSETS = ['MAI', 'EURS', 'ARB', 'GHO', 'FRAX', 'miMATIC'];

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
  if (!mod) {
    return existing;
  }

  const tokens = new Map<string, TokenInfo>(Object.entries(existing ?? {}));
  const entries = Object.keys(mod.assets).filter((key) => key.endsWith('_UNDERLYING'));

  for (const entry of entries) {
    const rawSymbol = entry.replace(mod.prefix, '').replace('_UNDERLYING', '');
    const derivedSymbol = normalizeSymbol(rawSymbol);
    const underlying = mod.assets[`${mod.prefix}${rawSymbol}_UNDERLYING`];
    const oracle = mod.assets[`${mod.prefix}${rawSymbol}_ORACLE`];
    if (!underlying) continue;

    let targetSymbol = derivedSymbol;
    let current = tokens.get(targetSymbol);
    if (!current) {
      for (const [existingSymbol, info] of tokens.entries()) {
        if (info.address?.toLowerCase() === underlying.toLowerCase()) {
          targetSymbol = existingSymbol;
          current = info;
          break;
        }
      }
    }
    const decimals = await fetchDecimals(rpcUrl, underlying, current?.decimals);
    const tokenInfo: TokenInfo = {
      address: underlying,
      decimals,
    };
    const overrideFeed = FEED_OVERRIDES[chainId]?.[targetSymbol];
    const feedAddress = overrideFeed ?? oracle;
    if (feedAddress && feedAddress !== '0x0000000000000000000000000000000000000000') {
      tokenInfo.chainlinkFeed = feedAddress;
    } else if (current?.chainlinkFeed) {
      tokenInfo.chainlinkFeed = current.chainlinkFeed;
    }
    tokens.set(targetSymbol, { ...current, ...tokenInfo });
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
  for (const chain of cfg.chains) {
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

  const denyAssets = new Set<string>(cfg.risk?.denyAssets ?? []);
  for (const symbol of DEFAULT_DENY_ASSETS) {
    denyAssets.add(symbol);
  }
  if (!cfg.risk) cfg.risk = {};
  cfg.risk.denyAssets = Array.from(denyAssets).sort();

  fs.writeFileSync(CONFIG_PATH, YAML.stringify(cfg, { lineWidth: 0 }));
  console.log('config.yaml updated: tokens and policies synced with Aave address book.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
