import { redis } from '../infra/redis';
import { log } from '../infra/logger';

const DEFAULT_LIMIT = Number(process.env.FABRIC_THROTTLE_LIMIT ?? 6);
const WINDOW_SEC = Number(process.env.FABRIC_THROTTLE_WINDOW_SEC ?? 300);

function edgeKey(chainId: number, pairId: string): string {
  return `laf:${chainId}:${pairId.toLowerCase()}`;
}

type MemoryEntry = {
  count: number;
  expiresAt: number;
};

const fallbackStore = new Map<string, MemoryEntry>();
let fallbackEnabled = false;

function enableFallback(err?: Error) {
  if (!fallbackEnabled) {
    fallbackEnabled = true;
    if (err) {
      log.warn({ err: err.message }, 'laf-throttle-fallback');
    }
  }
}

function memoryCount(key: string): number {
  const now = Date.now();
  const entry = fallbackStore.get(key);
  if (!entry || entry.expiresAt <= now) {
    fallbackStore.delete(key);
    return 0;
  }
  return entry.count;
}

function memoryIncrement(key: string): number {
  const now = Date.now();
  const expiresAt = now + WINDOW_SEC * 1000;
  const entry = fallbackStore.get(key);
  if (!entry || entry.expiresAt <= now) {
    const next = { count: 1, expiresAt };
    fallbackStore.set(key, next);
    return next.count;
  }
  entry.count += 1;
  entry.expiresAt = Math.max(entry.expiresAt, expiresAt);
  fallbackStore.set(key, entry);
  return entry.count;
}

export async function isEdgeThrottled(chainId: number, pairId: string, limit = DEFAULT_LIMIT): Promise<boolean> {
  if (limit <= 0) return false;
  const key = edgeKey(chainId, pairId);
  if (fallbackEnabled || !redis) {
    return memoryCount(key) >= limit;
  }
  try {
    const current = await redis.get(key);
    return current !== null && Number(current) >= limit;
  } catch (err) {
    enableFallback(err as Error);
    return memoryCount(key) >= limit;
  }
}

export async function recordEdgeAttempt(chainId: number, pairId: string): Promise<void> {
  const key = edgeKey(chainId, pairId);
  if (fallbackEnabled || !redis) {
    memoryIncrement(key);
    return;
  }
  try {
    await redis
      .multi()
      .incr(key)
      .expire(key, WINDOW_SEC, 'NX')
      .exec();
  } catch (err) {
    enableFallback(err as Error);
    memoryIncrement(key);
  }
}

export function resetEdgeThrottle(chainId: number, pairId: string): void {
  const key = edgeKey(chainId, pairId);
  if (fallbackEnabled || !redis) {
    fallbackStore.delete(key);
    return;
  }
  redis
    ?.del(key)
    .catch((err: Error) => {
      enableFallback(err);
      fallbackStore.delete(key);
    });
}
