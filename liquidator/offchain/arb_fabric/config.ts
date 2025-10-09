import fs from 'fs';
import YAML from 'yaml';
import { loadConfig, type AppConfig, type ChainCfg, type TokenInfo } from '../infra/config';
import { log } from '../infra/logger';
import { FabricConfig, FabricChainConfig, PairConfig, VenueConfig } from './types';

function ensureFile(path: string): string {
  if (!fs.existsSync(path)) {
    throw new Error(`Fabric config missing at ${path}`);
  }
  return fs.readFileSync(path, 'utf8');
}

export function loadFabricConfig(
  appCfg?: AppConfig,
  path = 'fabric.config.yaml',
): {
  fabric: FabricConfig;
  app: AppConfig;
} {
  const app = appCfg ?? loadConfig();
  const raw = ensureFile(path);
  const parsed = YAML.parse(raw) as FabricConfig;
  validateFabricConfig(parsed, app);
  return { fabric: parsed, app };
}

export function chainCfgOrThrow(app: AppConfig, chainId: number): ChainCfg {
  const chain = app.chains.find((c) => c.id === chainId);
  if (!chain) throw new Error(`Unknown chain ${chainId} in fabric config`);
  return chain;
}

export function tokenInfoOrThrow(chain: ChainCfg, symbol: string): TokenInfo {
  const token = chain.tokens[symbol];
  if (!token) {
    throw new Error(`Missing token ${symbol} on chain ${chain.id} (${chain.name})`);
  }
  return token;
}

function validateFabricConfig(cfg: FabricConfig, app: AppConfig): void {
  if (!cfg) throw new Error('Fabric config empty');
  if (!cfg.global) throw new Error('Fabric config missing global settings');
  if (!Array.isArray(cfg.chains)) throw new Error('Fabric config must include chains');
  for (const chain of cfg.chains) {
    validateFabricChain(cfg, chain, app);
  }
}

function validateFabricChain(root: FabricConfig, chainCfg: FabricChainConfig, app: AppConfig): void {
  if (!Number.isFinite(chainCfg.chainId)) throw new Error('Fabric chain missing chainId');
  const chain = chainCfgOrThrow(app, chainCfg.chainId);
  tokenInfoOrThrow(chain, chainCfg.nativeToken);
  if (!Array.isArray(chainCfg.pairs) || chainCfg.pairs.length === 0) {
    throw new Error(`Fabric chain ${chain.id} has no pairs configured`);
  }
  for (const pair of chainCfg.pairs) {
    validatePair(chainCfg, pair, chain, root.global);
  }
}

function validatePair(
  chainCfg: FabricChainConfig,
  pair: PairConfig,
  chain: ChainCfg,
  global: FabricConfig['global'],
): void {
  if (!pair.id) throw new Error(`Fabric pair missing id on chain ${chainCfg.chainId}`);
  tokenInfoOrThrow(chain, pair.baseToken);
  tokenInfoOrThrow(chain, pair.quoteToken);
  if (!pair.tradeSize?.baseAmount) {
    throw new Error(`Fabric pair ${pair.id} missing tradeSize.baseAmount`);
  }
  if (!Array.isArray(pair.venues) || pair.venues.length < 2) {
    throw new Error(`Fabric pair ${pair.id} must include at least two venues for single-hop`);
  }
  for (const venue of pair.venues) {
    validateVenue(venue, chain);
  }
  const minNet = pair.minNetUsd ?? global.minNetUsd;
  if (minNet <= 0) throw new Error(`Fabric pair ${pair.id} has non-positive minNetUsd`);
}

function validateVenue(venue: VenueConfig, chain: ChainCfg): void {
  if (!venue.id) throw new Error(`Venue missing id on chain ${chain.id}`);
  if (venue.kind !== 'uniswap_v3') {
    throw new Error(`Unsupported venue kind ${(venue as any)?.kind ?? 'unknown'}`);
  }
  if (typeof venue.feeBps !== 'number' || venue.feeBps <= 0) {
    throw new Error(`Uniswap v3 venue ${venue.id} missing feeBps`);
  }
}

export function logFabricConfig(cfg: FabricConfig): void {
  log.info(
    {
      mode: cfg.global.mode,
      chains: cfg.chains.map((c) => ({
        chainId: c.chainId,
        pairs: c.pairs.length,
      })),
    },
    'fabric-config-loaded',
  );
}
