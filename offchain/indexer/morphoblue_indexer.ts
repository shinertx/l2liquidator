import { AppConfig, ChainCfg, preliqChainConfig, preliqEnabled, preliqConfig } from '../infra/config';
import type { Candidate } from './aave_indexer';
import { getPublicClient, type ManagedClient } from '../infra/rpc_clients';
import { parseAbiItem, type Address, type Hash, encodeAbiParameters, keccak256, getCreate2Address } from 'viem';
import { base, arbitrum, optimism } from 'viem/chains';
import { log } from '../infra/logger';
import { redis } from '../infra/redis';

const DEFAULT_ENDPOINT =
  process.env.MORPHO_BLUE_GRAPHQL_ENDPOINT?.trim() ??
  'https://blue-api.morpho.org/graphql';
const DEFAULT_MAX_COMPLEXITY = Number(process.env.MORPHO_BLUE_MAX_COMPLEXITY ?? 1000);
const DEFAULT_LIMIT = Number(process.env.MORPHO_BLUE_FIRST ?? 500);
const DEFAULT_HF_THRESHOLD = Number(process.env.MORPHO_BLUE_HF_THRESHOLD ?? 1.05);
const DEFAULT_POLL_DELAY_MS = Number(process.env.MORPHO_BLUE_POLL_DELAY_MS ?? 5_000);
const DEFAULT_MIN_POLL_DELAY_MS = Math.max(1_000, Number(process.env.MORPHO_BLUE_MIN_POLL_DELAY_MS ?? 1_000));
const DEFAULT_MAX_POLL_DELAY_MS = Math.max(
  DEFAULT_MIN_POLL_DELAY_MS,
  Number(process.env.MORPHO_BLUE_MAX_POLL_DELAY_MS ?? 30_000)
);
const DEFAULT_BACKOFF_MULTIPLIER = Math.max(1, Number(process.env.MORPHO_BLUE_BACKOFF_MULTIPLIER ?? 2));
const DEFAULT_SUCCESS_DELAY_MS = Math.max(
  DEFAULT_MIN_POLL_DELAY_MS,
  Number(process.env.MORPHO_BLUE_SUCCESS_DELAY_MS ?? 5_000)
);
const WAIT_FLOOR_MS = Math.max(50, Number(process.env.MORPHO_BLUE_WAIT_FLOOR_MS ?? 100));
const DEFAULT_DEDUPE_MS = Number(process.env.MORPHO_BLUE_DEDUPE_MS ?? 60_000);

const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as Address;
const DEFAULT_PRELIQ_CACHE_MS = Number(process.env.MORPHO_PRELIQ_CACHE_MS ?? 60_000);
type ChainPollingConfig = {
  baseInterval: number;
  minInterval: number;
  maxInterval: number;
  successInterval: number;
};

function resolveChainPollingConfig(cfg: AppConfig, chainId: number): ChainPollingConfig {
  const root = preliqConfig(cfg);
  const chainCfg = preliqChainConfig(cfg, chainId);
  const desiredInterval = chainCfg?.pollIntervalMs ?? root?.pollIntervalMs;
  const baseInterval = Math.max(DEFAULT_MIN_POLL_DELAY_MS, desiredInterval ?? DEFAULT_POLL_DELAY_MS);
  const minInterval = Math.max(DEFAULT_MIN_POLL_DELAY_MS, desiredInterval ?? baseInterval);
  const successInterval = Math.max(
    DEFAULT_MIN_POLL_DELAY_MS,
    chainCfg?.pollIntervalMs ?? root?.pollIntervalMs ?? DEFAULT_SUCCESS_DELAY_MS
  );
  const configuredMax = chainCfg?.pollIntervalMs ?? root?.pollIntervalMs;
  const maxInterval = Math.max(
    baseInterval,
    configuredMax ? Math.max(baseInterval, configuredMax * 4) : DEFAULT_MAX_POLL_DELAY_MS
  );
  return { baseInterval, minInterval, maxInterval, successInterval };
}

function resolveChainHfThreshold(cfg: AppConfig, chainId: number): number {
  const root = preliqConfig(cfg);
  const chainCfg = preliqChainConfig(cfg, chainId);
  const threshold = chainCfg?.maxHealthFactor ?? root?.maxHealthFactor ?? DEFAULT_HF_THRESHOLD;
  return Math.max(1.0, threshold);
}

function resolveDedupeWindow(cfg: AppConfig): number {
  const root = preliqConfig(cfg);
  if (root?.cacheTtlMs && root.cacheTtlMs > 0) {
    return root.cacheTtlMs;
  }
  if (cfg.indexer?.dedupeMs && cfg.indexer.dedupeMs > 0) {
    return cfg.indexer.dedupeMs;
  }
  return DEFAULT_DEDUPE_MS;
}

function resolveFetchLimit(cfg: AppConfig): number {
  const configured = cfg.indexer?.subgraphFirst ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(2000, configured));
}

function getViemChain(chainId: number) {
  if (chainId === base.id) return base;
  if (chainId === arbitrum.id) return arbitrum;
  if (chainId === optimism.id) return optimism;
  throw new Error(`Unsupported chain: ${chainId}`);
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

// --- Pre-Liquidation Offer Enrichment ---

type PreLiqOffer = {
  offerAddress: Address;
  effectiveCloseFactor: number;
  effectiveLiquidationIncentive: number;
  oracleAddress: Address;
  expiry: bigint;
};

const offerParamCache = new Map<string, { value: Omit<PreLiqOffer, 'offerAddress'>; expiresAt: number }>();
const REDIS_CACHE_PREFIX = 'preliq:offer_params:';

/**
 * Compute CREATE2 address for a pre-liquidation offer
 * Address = CREATE2(factory, keccak256(borrower, marketId), initCodeHash)
 */
function computeOfferAddress(cfg: AppConfig, chainId: number, borrower: Address, marketId: Hash): Address {
  const chainCfg = preliqChainConfig(cfg, chainId);
  if (!chainCfg?.factory || !chainCfg.initCodeHash) {
    return '0x0000000000000000000000000000000000000000';
  }

  const salt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [borrower, marketId]
    )
  );

  return getCreate2Address({ from: chainCfg.factory, salt, bytecodeHash: chainCfg.initCodeHash as Hash });
}

/**
 * Check if borrower has authorized the pre-liq offer to liquidate on their behalf
 */
async function checkOfferAuthorization(
  client: ManagedClient,
  borrower: Address,
  offerAddress: Address,
  morphoAddress?: Address
): Promise<boolean> {
  if (offerAddress === '0x0000000000000000000000000000000000000000') return false;

  const targetMorpho = morphoAddress ?? MORPHO_BLUE;

  try {
    const authorized = await client.readContract({
      address: targetMorpho,
      abi: [{
        type: 'function',
        name: 'isAuthorized',
        stateMutability: 'view',
        inputs: [
          { name: 'authorizer', type: 'address' },
          { name: 'authorized', type: 'address' }
        ],
        outputs: [{ name: '', type: 'bool' }],
      }],
      functionName: 'isAuthorized',
      args: [borrower, offerAddress],
    }) as boolean;
    return authorized;
  } catch (err) {
    log.debug({ borrower, offer: offerAddress, err: (err as Error).message }, 'preliq-authorization-check-failed');
    return false;
  }
}

/**
 * Fetch pre-liq offer parameters from the deployed contract
 * Returns effective CF and LIF based on current health factor via linear interpolation
 */
async function fetchOfferParams(
  client: ManagedClient,
  chainId: number,
  offerAddress: Address,
  healthFactor: number,
  cacheMs: number
): Promise<Omit<PreLiqOffer, 'offerAddress'> | null> {
  if (offerAddress === '0x0000000000000000000000000000000000000000') return null;

  const cacheKey = `${chainId}:${offerAddress.toLowerCase()}`;
  const cached = offerParamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (redis) {
    try {
      const raw = await redis.get(`${REDIS_CACHE_PREFIX}${cacheKey}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { effectiveCloseFactor: number; effectiveLiquidationIncentive: number; oracleAddress: Address; expiry: string };
        const value = {
          effectiveCloseFactor: parsed.effectiveCloseFactor,
          effectiveLiquidationIncentive: parsed.effectiveLiquidationIncentive,
          oracleAddress: parsed.oracleAddress,
          expiry: BigInt(parsed.expiry),
        } satisfies Omit<PreLiqOffer, 'offerAddress'>;
        offerParamCache.set(cacheKey, { value, expiresAt: Date.now() + Math.max(1_000, cacheMs) });
        return value;
      }
    } catch (err) {
      log.debug({ err: (err as Error).message, cacheKey }, 'preliq-offer-redis-cache-miss');
    }
  }

  try {
    // Parallel reads for all offer parameters
    const [preLLTV, preLCF1, preLCF2, preLIF1, preLIF2, oracle, expiry] = await Promise.all([
      client.readContract({
        address: offerAddress,
        abi: [{ type: 'function', name: 'preLLTV', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
        functionName: 'preLLTV',
      }) as Promise<bigint>,
      client.readContract({
        address: offerAddress,
        abi: [{ type: 'function', name: 'preLCF1', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
        functionName: 'preLCF1',
      }) as Promise<bigint>,
      client.readContract({
        address: offerAddress,
        abi: [{ type: 'function', name: 'preLCF2', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
        functionName: 'preLCF2',
      }) as Promise<bigint>,
      client.readContract({
        address: offerAddress,
        abi: [{ type: 'function', name: 'preLIF1', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
        functionName: 'preLIF1',
      }) as Promise<bigint>,
      client.readContract({
        address: offerAddress,
        abi: [{ type: 'function', name: 'preLIF2', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
        functionName: 'preLIF2',
      }) as Promise<bigint>,
      client.readContract({
        address: offerAddress,
        abi: [{ type: 'function', name: 'oracle', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }],
        functionName: 'oracle',
      }) as Promise<Address>,
      client.readContract({
        address: offerAddress,
        abi: [{ type: 'function', name: 'expiry', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
        functionName: 'expiry',
      }) as Promise<bigint>,
    ]);

    // Linear interpolation: HF ranges from preLLTV/1e18 (CF=preLCF2, LIF=preLIF2) to 1.0 (CF=preLCF1, LIF=preLIF1)
    const hfMin = Number(preLLTV) / 1e18;
    const hfMax = 1.0;
    const t = Math.max(0, Math.min(1, (healthFactor - hfMin) / (hfMax - hfMin)));

    const effectiveCloseFactor = Number(preLCF1) + t * (Number(preLCF2) - Number(preLCF1));
    const effectiveLiquidationIncentive = Number(preLIF1) + t * (Number(preLIF2) - Number(preLIF1));

    const value = {
      effectiveCloseFactor: effectiveCloseFactor / 1e18,
      effectiveLiquidationIncentive: effectiveLiquidationIncentive / 1e18,
      oracleAddress: oracle,
      expiry,
    };
    offerParamCache.set(cacheKey, { value, expiresAt: Date.now() + Math.max(1_000, cacheMs) });
    if (redis) {
      void redis.set(
        `${REDIS_CACHE_PREFIX}${cacheKey}`,
        JSON.stringify({
          effectiveCloseFactor: value.effectiveCloseFactor,
          effectiveLiquidationIncentive: value.effectiveLiquidationIncentive,
          oracleAddress: value.oracleAddress,
          expiry: value.expiry.toString(),
        }),
        'PX',
        Math.max(1_000, cacheMs),
      ).catch((err) => log.debug({ err: err instanceof Error ? err.message : String(err) }, 'preliq-offer-redis-cache-set-failed'));
    }
    return value;
  } catch (err) {
    log.debug({ chainId, offer: offerAddress, err: (err as Error).message }, 'preliq-offer-params-failed');
    return null;
  }
}

/**
 * Enrich a Morpho Blue candidate with pre-liquidation offer if available
 * Called when 1.0 < HF <= 1.05 to check for offers
 */
async function enrichWithPreLiqOffer(
  cfg: AppConfig,
  candidate: Candidate,
  chain: ChainCfg
): Promise<Candidate> {
  if (!preliqEnabled(cfg, chain.id)) return candidate;
  if (!candidate.morpho) return candidate;

  const chainPreliq = preliqChainConfig(cfg, chain.id);
  if (!chainPreliq) return candidate;
  const maxHf = chainPreliq?.maxHealthFactor ?? cfg.preliq?.maxHealthFactor ?? 1.05;

  const { healthFactor } = candidate;
  if (!healthFactor || healthFactor >= maxHf || healthFactor <= 1.0) return candidate;

  const client = getPublicClient(chain);

  // Compute offer address via CREATE2
  const marketId = candidate.morpho.uniqueKey as Hash;
  const offerAddress = computeOfferAddress(cfg, chain.id, candidate.borrower, marketId);

  if (offerAddress === '0x0000000000000000000000000000000000000000') {
    return candidate;
  }

  // Check authorization
  const authorized = await checkOfferAuthorization(
    client,
    candidate.borrower,
    offerAddress,
    chainPreliq?.morpho as Address | undefined
  );
  if (!authorized) return candidate;

  const cacheMs = chainPreliq?.cacheTtlMs ?? cfg.preliq?.cacheTtlMs ?? DEFAULT_PRELIQ_CACHE_MS;

  // Fetch offer parameters
  const offerParams = await fetchOfferParams(client, chain.id, offerAddress, healthFactor, cacheMs);
  if (!offerParams) return candidate;

  // Check expiry
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (offerParams.expiry <= now) return candidate;

  // Enrich candidate with pre-liq offer
  return {
    ...candidate,
    preliq: {
      offerAddress,
      ...offerParams,
    },
  } as Candidate & { preliq: PreLiqOffer };
}

// --- End Pre-Liquidation Enrichment ---

async function fetchMorphoPositions(
  cfg: AppConfig,
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
    
    // Convert positions to candidates
    const baseCandidates = positions
      .map((item) => toCandidate(chain, item))
      .filter((candidate): candidate is Candidate => candidate !== null);

    // Enrich with pre-liq offers if enabled (parallel enrichment for performance)
    if (preliqEnabled(cfg, chain.id)) {
      const enrichedCandidates = await Promise.all(
        baseCandidates.map((candidate) => enrichWithPreLiqOffer(cfg, candidate, chain))
      );
      return { items: enrichedCandidates };
    }

    return { items: baseCandidates };
  } catch (err) {
    return { items: [], notes: `morpho-fetch-error:${(err as Error).message}` };
  }
}

export async function pollMorphoBlueCandidatesOnce(
  cfg: AppConfig,
  chain: ChainCfg,
  first?: number,
  hfThreshold?: number,
): Promise<{ candidates: Candidate[]; notes?: string }> {
  if (!chain.enabled) return { candidates: [] };
  if (!preliqEnabled(cfg, chain.id)) return { candidates: [], notes: 'preliq-disabled' };

  const limit = Math.max(1, Math.min(2000, first ?? resolveFetchLimit(cfg)));
  const threshold = hfThreshold ?? resolveChainHfThreshold(cfg, chain.id);

  const { items, notes } = await fetchMorphoPositions(cfg, chain, limit, threshold);
  return { candidates: items, notes };
}

export async function* streamMorphoBlueCandidates(cfg: AppConfig): AsyncGenerator<Candidate> {
  const chains = cfg.chains.filter((c) => c.enabled && preliqEnabled(cfg, c.id));
  if (chains.length === 0) return;

  const dedupe = new Map<string, number>();
  const dedupeWindowMs = resolveDedupeWindow(cfg);
  const limit = resolveFetchLimit(cfg);
  const schedule = new Map<number, { next: number; interval: number }>();
  const pollingConfig = new Map<number, ChainPollingConfig>();
  const boot = Date.now();

  for (const chain of chains) {
    const params = resolveChainPollingConfig(cfg, chain.id);
    pollingConfig.set(chain.id, params);
    schedule.set(chain.id, { next: boot, interval: params.baseInterval });
  }

  while (true) {
    const loopStart = Date.now();
    let dispatched = false;

    for (const chain of chains) {
      const params = pollingConfig.get(chain.id) ?? resolveChainPollingConfig(cfg, chain.id);
      const current = schedule.get(chain.id) ?? { next: loopStart, interval: params.baseInterval };
      if (loopStart < current.next) {
        schedule.set(chain.id, current);
        continue;
      }

      dispatched = true;
      const hfThreshold = resolveChainHfThreshold(cfg, chain.id);
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
        schedule.set(chain.id, { next: processedAt + params.successInterval, interval: params.successInterval });
      } else {
        const previous = Math.max(params.minInterval, current.interval);
        const grown = Math.min(
          params.maxInterval,
          Math.max(params.minInterval, Math.floor(previous * DEFAULT_BACKOFF_MULTIPLIER))
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
        : Math.max(WAIT_FLOOR_MS, DEFAULT_POLL_DELAY_MS);
      await sleep(waitMs);
    }
  }
}
