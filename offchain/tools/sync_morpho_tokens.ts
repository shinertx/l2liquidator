#!/usr/bin/env ts-node

import '../infra/env';
import fs from 'fs';
import path from 'path';
import YAML, { isMap, isScalar, isSeq, YAMLMap } from 'yaml';

const CONFIG_PATH = path.resolve(__dirname, '../../config.yaml');
const GRAPH_ENDPOINT = (process.env.MORPHO_BLUE_GRAPHQL_ENDPOINT ?? 'https://blue-api.morpho.org/graphql').trim();
const MARKET_FETCH_LIMIT = Math.max(100, Math.min(1000, Number(process.env.MORPHO_MARKET_FETCH_LIMIT ?? 500)));

type GraphAsset = {
  symbol?: string | null;
  address?: string | null;
  decimals?: number | null;
};

type GraphMarket = {
  loanAsset?: GraphAsset | null;
  collateralAsset?: GraphAsset | null;
};

type GraphResponse = {
  data?: {
    markets?: {
      items?: GraphMarket[];
    };
  };
  errors?: Array<{ message?: string }>;
};

type TokenMetadata = {
  address: string;
  decimals: number;
};

type PolicyCategory = 'stable' | 'lst' | 'major' | 'governance' | 'other';

const STABLES = new Set(
  [
    'USDC',
    'USDCN',
    'USDT',
    'USDE',
    'DAI',
    'LUSD',
    'FRAX',
    'MAI',
    'SUSD',
    'EUSD',
    'EURA',
    'JEUR',
    'STEUR',
    'USDZ',
    'WUSD+',
    'WUSDM',
    'SATUSD',
    'USR',
    'MTBILL',
    'VERUSDC',
    'FUSDC',
    'USDBC',
    'USDS',
    'WWFUSDC',
    'CUSD',
    'GHO',
    'USDR',
    'CRVUSD',
    'DOLA',
    'MUSD',
    'PYUSD',
  ].map((s) => s.toUpperCase()),
);

const LSTS = new Set(
  [
    'WSTETH',
    'STETH',
    'WEETH',
    'RETH',
    'CBETH',
    'EZETH',
    'RSETH',
    'WRSETH',
    'MSETH',
    'WSUPEROETHB',
    'BSDETH',
    'SFRXETH',
    'OSETH',
    'ETHX',
    'SWETH',
    'WBETH',
    'LSETH',
    'METH',
    'LBTC',
  ].map((s) => s.toUpperCase()),
);

const MAJORS = new Set(
  [
    'WETH',
    'ETH',
    'WBTC',
    'BTC',
    'CBTC',
    'ARB',
    'OP',
    'AAVE',
    'LINK',
    'BAL',
    'CRV',
    'GMX',
    'UNI',
    'COMP',
    'MKR',
    'SNX',
    'LDO',
  ].map((s) => s.toUpperCase()),
);

const GOVERNANCE = new Set(
  [
    'AERO',
    'DEGEN',
    'KTA',
    'DOGINME',
    'TOSHI',
  ].map((s) => s.toUpperCase()),
);

const BLOCKED_SYMBOLS = new Set(['UNKNOWN', 'SYMBOL', 'TEST']);

const DEFAULT_POLICIES: Record<PolicyCategory, { floorBps: number; gapCapBps: number; slippageBps: number }> = {
  stable: { floorBps: 30, gapCapBps: 50, slippageBps: 50 },
  lst: { floorBps: 30, gapCapBps: 70, slippageBps: 30 },
  major: { floorBps: 30, gapCapBps: 60, slippageBps: 30 },
  governance: { floorBps: 40, gapCapBps: 90, slippageBps: 40 },
  other: { floorBps: 50, gapCapBps: 110, slippageBps: 60 },
};

const GRAPH_QUERY = `query MorphoTokenSync($chainIds:[Int!],$first:Int!){
  markets(first:$first, where:{chainId_in:$chainIds}){
    items{
      loanAsset{ symbol address decimals }
      collateralAsset{ symbol address decimals }
    }
  }
}`;

function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function normalizeDecimals(value: number | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 36) {
    return Math.round(value);
  }
  return 18;
}

function classifyToken(symbol: string): PolicyCategory {
  const upper = symbol.toUpperCase();
  if (STABLES.has(upper)) return 'stable';
  if (LSTS.has(upper)) return 'lst';
  if (MAJORS.has(upper)) return 'major';
  if (GOVERNANCE.has(upper)) return 'governance';
  return 'other';
}

async function fetchMorphoMarkets(chainId: number): Promise<GraphMarket[]> {
  const response = await fetch(GRAPH_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-apollo-operation-name': 'MorphoTokenSync',
    },
    body: JSON.stringify({
      query: GRAPH_QUERY,
      variables: {
        chainIds: [chainId],
        first: MARKET_FETCH_LIMIT,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL responded with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as GraphResponse;
  if (payload.errors?.length) {
    const message = payload.errors.map((err) => err.message ?? 'unknown error').join('; ');
    throw new Error(message);
  }

  return payload.data?.markets?.items ?? [];
}

type TokenMapOptions = {
  existingSymbols: Map<string, string>;
  allowNew: boolean;
  preferredAddresses: Map<string, string>;
};

function buildTokenMap(markets: GraphMarket[], options: TokenMapOptions): Map<string, TokenMetadata> {
  const tokens = new Map<string, TokenMetadata>();

  for (const market of markets) {
    const candidates = [market.loanAsset, market.collateralAsset];
    for (const asset of candidates) {
      if (!asset?.symbol) continue;
      const symbol = asset.symbol.trim();
      if (!symbol) continue;
      const upper = symbol.toUpperCase();
      if (BLOCKED_SYMBOLS.has(upper)) continue;

      const canonicalSymbol = options.existingSymbols.get(upper) ?? symbol;
      const hasExisting = options.existingSymbols.has(upper);
      if (!hasExisting && !options.allowNew) {
        continue;
      }

      const address = normalizeAddress(asset.address);
      if (!address) continue;
      const decimals = normalizeDecimals(asset.decimals ?? undefined);

      const preferredAddress = options.preferredAddresses.get(upper);
      const targetAddress = preferredAddress ?? address;

      const existing = tokens.get(canonicalSymbol);
      if (!existing) {
        tokens.set(canonicalSymbol, { address: targetAddress, decimals });
        continue;
      }

      const existingAddr = existing.address.toLowerCase();
      const nextAddr = targetAddress.toLowerCase();
      const rawAddr = address.toLowerCase();

      if (existingAddr === nextAddr) {
        if (existing.decimals !== decimals) {
          tokens.set(canonicalSymbol, { address: existing.address, decimals });
        }
        continue;
      }

      if (preferredAddress) {
        const preferredLower = preferredAddress.toLowerCase();
        if (existingAddr === preferredLower) {
          continue;
        }
        if (rawAddr === preferredLower || nextAddr === preferredLower) {
          tokens.set(canonicalSymbol, { address: preferredAddress, decimals });
          continue;
        }
      }

      console.warn(`⚠️  Symbol ${symbol} has conflicting addresses (${existing.address} vs ${address}); keeping first seen value.`);
    }
  }

  return tokens;
}

async function main(): Promise<void> {
  console.log('🚀 Morpho Blue token metadata sync');

  if (!GRAPH_ENDPOINT) {
    console.error('❌ Morpho GraphQL endpoint is not configured. Set MORPHO_BLUE_GRAPHQL_ENDPOINT.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const allowNew = args.includes('--allow-new');
  const updateAddresses = args.includes('--update-addresses');
  const chainArg = args.find((value) => value.startsWith('--chain='));
  const onlyChain = chainArg ? Number(chainArg.split('=')[1]) : undefined;

  const configYaml = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = YAML.parse(configYaml) as any;
  const doc = YAML.parseDocument(configYaml);
  const chainsNode = doc.get('chains');
  if (!isSeq(chainsNode)) {
    console.error('❌ config.yaml does not contain a chains array.');
    process.exit(1);
  }

  const candidateChains = new Set<number>();

  const morphoMarkets = Array.isArray(config.markets)
    ? config.markets.filter((market: any) => market?.protocol === 'morphoblue')
    : [];
  for (const market of morphoMarkets) {
    const id = Number(market?.chainId);
    if (Number.isFinite(id)) {
      candidateChains.add(id);
    }
  }

  const preliqChains = config.preliq?.chains ?? {};
  for (const [key, value] of Object.entries(preliqChains)) {
    if (value && (value as any).enabled === false) continue;
    const id = Number(key);
    if (Number.isFinite(id)) {
      candidateChains.add(id);
    }
  }

  for (const chain of config.chains ?? []) {
    if (!chain) continue;
    if (chain.morphoProvider) {
      const id = Number(chain.id);
      if (Number.isFinite(id)) {
        candidateChains.add(id);
      }
    }
  }

  const chainIds = Array.from(candidateChains)
    .filter((id) => (onlyChain ? id === onlyChain : true))
    .sort((a, b) => a - b);

  if (chainIds.length === 0) {
    if (onlyChain) {
      console.log('ℹ️  No matching chains found for provided filters.');
    } else {
      console.log('ℹ️  No Morpho-enabled chains detected; nothing to sync.');
    }
    return;
  }

  let totalAdded = 0;
  let totalUpdated = 0;
  let policyAdded = 0;
  let changed = false;

  for (const chainId of chainIds) {
    const chainCfg = (config.chains ?? []).find((chain: any) => chain?.id === chainId);
    if (!chainCfg) {
      console.warn(`⚠️  Chain ${chainId} is referenced in markets but missing from chains config.`);
      continue;
    }

    const chainNode = chainsNode.items
      .filter((item: unknown): item is YAMLMap => isMap(item))
      .find((item) => {
        const idNode = item.get('id', true);
        if (!isScalar(idNode)) return false;
        const idValue = Number(idNode.value);
        return Number.isFinite(idValue) && idValue === chainId;
      });

    if (!chainNode) {
      console.warn(`⚠️  Chain ${chainId} could not be located within YAML document; skipping.`);
      continue;
    }

    const chainName = chainCfg.name ?? chainId;
    console.log(`\n🔍 Syncing chain ${chainName} (${chainId})`);

    let markets: GraphMarket[] = [];
    try {
      markets = await fetchMorphoMarkets(chainId);
    } catch (err) {
      console.error(`  ❌ Failed to fetch markets: ${(err as Error).message}`);
      continue;
    }

    const existingTokens: Record<string, any> = { ...(chainCfg.tokens ?? {}) };
    const chainSymbolMap = new Map<string, string>();
    for (const symbol of Object.keys(existingTokens)) {
      chainSymbolMap.set(symbol.toUpperCase(), symbol);
    }

    if (markets.length === 0) {
      console.log('  ℹ️  Graph returned no markets; skipping chain.');
      continue;
    }

    const preferredAddresses = new Map<string, string>();
    for (const [symbol, data] of Object.entries(existingTokens)) {
      if (data && typeof data.address === 'string') {
        preferredAddresses.set(symbol.toUpperCase(), data.address);
      }
    }

    const tokenMap = buildTokenMap(markets, {
      existingSymbols: chainSymbolMap,
      allowNew,
      preferredAddresses,
    });

    if (tokenMap.size === 0) {
      console.log('  ℹ️  No token metadata discovered; skipping chain.');
      continue;
    }

    let tokensMap: YAMLMap<unknown, unknown>;
    const existingTokensNode = chainNode.get('tokens', true);
    if (existingTokensNode && isMap(existingTokensNode)) {
      tokensMap = existingTokensNode as YAMLMap<unknown, unknown>;
    } else {
      const newTokensNode = doc.createNode({}) as YAMLMap<unknown, unknown>;
      chainNode.set('tokens', newTokensNode);
      tokensMap = newTokensNode;
    }
    let chainAdded = 0;
    let chainUpdated = 0;

    for (const [symbol, metadata] of tokenMap) {
      const upper = symbol.toUpperCase();
      if (BLOCKED_SYMBOLS.has(upper)) continue;

      const canonical = chainSymbolMap.get(upper) ?? symbol;
      if (!chainSymbolMap.has(upper) && !allowNew) {
        continue;
      }
      const targetSymbol = canonical;

      const current = existingTokens[targetSymbol];

      if (!current) {
        existingTokens[targetSymbol] = {
          address: metadata.address,
          decimals: metadata.decimals,
        };
        chainAdded += 1;
        chainSymbolMap.set(upper, targetSymbol);
        console.log(`  ✅ Added ${targetSymbol.padEnd(12)} ${metadata.address}`);
        tokensMap.set(targetSymbol, doc.createNode({ address: metadata.address, decimals: metadata.decimals }));

        const policyCategory = classifyToken(targetSymbol);
        let assetsMap: YAMLMap<unknown, unknown>;
        const existingAssetsNode = doc.get('assets');
        if (existingAssetsNode && isMap(existingAssetsNode)) {
          assetsMap = existingAssetsNode as YAMLMap<unknown, unknown>;
        } else {
          assetsMap = doc.createNode({}) as YAMLMap<unknown, unknown>;
          doc.set('assets', assetsMap);
        }
        if (!assetsMap.has(targetSymbol)) {
          assetsMap.set(targetSymbol, doc.createNode({ ...DEFAULT_POLICIES[policyCategory] }));
          config.assets = config.assets ?? {};
          config.assets[targetSymbol] = { ...DEFAULT_POLICIES[policyCategory] };
          policyAdded += 1;
          console.log(`    • Applied ${policyCategory} policy (${JSON.stringify(DEFAULT_POLICIES[policyCategory])})`);
        }
        continue;
      }

      const next = { ...current };
      let updated = false;

      if (!next.address || typeof next.address !== 'string') {
        next.address = metadata.address;
        updated = true;
      } else if (next.address.toLowerCase() !== metadata.address.toLowerCase()) {
        if (updateAddresses) {
          next.address = metadata.address;
          updated = true;
        } else {
          console.warn(`  ⚠️  ${targetSymbol} address mismatch (${next.address} vs ${metadata.address}); skipping update. Use --update-addresses to override.`);
        }
      }

      const currentDecimals = Number(next.decimals);
      if (!Number.isFinite(currentDecimals) || currentDecimals !== metadata.decimals) {
        next.decimals = metadata.decimals;
        updated = true;
      }

      if (updated) {
        existingTokens[targetSymbol] = next;
        chainUpdated += 1;
        console.log(`  ✏️  Updated ${targetSymbol.padEnd(12)} ${metadata.address}`);

        const existingNode = tokensMap.get(targetSymbol, true);
        let tokenMap: YAMLMap;
        if (!existingNode || !isMap(existingNode)) {
          tokenMap = doc.createNode(tokensMap.get(targetSymbol) ?? {}) as YAMLMap;
          tokensMap.set(targetSymbol, tokenMap);
        } else {
          tokenMap = existingNode;
        }

        tokenMap.set('address', next.address);
        tokenMap.set('decimals', next.decimals);
      }
    }

    if (chainAdded > 0 || chainUpdated > 0) {
      chainCfg.tokens = existingTokens;
      totalAdded += chainAdded;
      totalUpdated += chainUpdated;
      changed = true;
    } else {
      console.log('  ℹ️  Tokens already up to date.');
    }
  }

  if (!changed && policyAdded === 0) {
    console.log('\n✅ Morpho token metadata already in sync.');
    return;
  }

  if (dryRun) {
    console.log(`\nℹ️  Dry run complete. Would add ${totalAdded} tokens, update ${totalUpdated}, and create ${policyAdded} policies.`);
    return;
  }

  const updatedYaml = doc.toString({ indent: 2, lineWidth: 0 });
  fs.writeFileSync(CONFIG_PATH, updatedYaml);

  console.log(`\n✅ Sync complete. Added ${totalAdded} tokens, updated ${totalUpdated}, new policies ${policyAdded}.`);
}

main().catch((err) => {
  console.error('❌ Fatal error during Morpho token sync:', err);
  process.exit(1);
});
