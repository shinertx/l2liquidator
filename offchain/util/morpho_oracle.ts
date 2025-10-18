import type { Address } from 'viem';
import type { ManagedClient } from '../infra/rpc_clients';
import { log } from '../infra/logger';

const RATIO_SCALE = 10n ** 36n;
const RATIO_SCALE_FLOAT = Number(RATIO_SCALE);
const CACHE_MS = Math.max(5_000, Number(process.env.MORPHO_ORACLE_CACHE_MS ?? 30_000));

const MORPHO_ORACLE_ABI = [
  {
    name: 'price',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

type CacheEntry = {
  ratio: number;
  expiresAtMs: number;
};

const cache = new Map<string, CacheEntry>();

function cacheKey(oracle: Address): string {
  return oracle.toLowerCase();
}

export async function getMorphoOracleRatio(client: ManagedClient, oracle: Address): Promise<number | null> {
  const key = cacheKey(oracle);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAtMs > now) {
    return cached.ratio > 0 ? cached.ratio : null;
  }

  try {
    const raw = (await client.readContract({
      address: oracle,
      abi: MORPHO_ORACLE_ABI,
      functionName: 'price',
    })) as bigint;

    if (raw <= 0n) {
      cache.set(key, { ratio: 0, expiresAtMs: now + CACHE_MS });
      return null;
    }

    const ratio = Number(raw) / RATIO_SCALE_FLOAT;
    if (!Number.isFinite(ratio) || ratio <= 0) {
      cache.set(key, { ratio: 0, expiresAtMs: now + CACHE_MS });
      return null;
    }

    cache.set(key, { ratio, expiresAtMs: now + CACHE_MS });
    return ratio;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ oracle, err: message }, 'morpho-oracle-ratio-failed');
    cache.set(key, { ratio: 0, expiresAtMs: now + CACHE_MS });
    return null;
  }
}

export function invalidateMorphoOracleRatio(oracle: Address): void {
  cache.delete(cacheKey(oracle));
}
