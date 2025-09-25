import { redis } from './redis';
import { log } from './logger';

const DEFAULT_WINDOW_SEC = 3600;

function key(chainId: number, borrower: `0x${string}`) {
  return `throttle:${chainId}:${borrower.toLowerCase()}`;
}

type FallbackEntry = { count: number; expiresAt: number };

const fallbackStore = new Map<string, FallbackEntry>();
let fallbackEnabled = false;
let fallbackWarned = false;

function enableFallback(err?: Error) {
  if (!fallbackEnabled) {
    fallbackEnabled = true;
    if (!fallbackWarned) {
      log.warn({ err: err?.message }, 'throttle-fallback-enabled');
      fallbackWarned = true;
    }
  }
}

function fallbackCount(chainId: number, borrower: `0x${string}`): number {
  const now = Date.now();
  const k = key(chainId, borrower);
  const entry = fallbackStore.get(k);
  if (!entry || entry.expiresAt <= now) {
    fallbackStore.delete(k);
    return 0;
  }
  return entry.count;
}

function fallbackIncrement(chainId: number, borrower: `0x${string}`, windowSec: number): number {
  const now = Date.now();
  const expiresAt = now + windowSec * 1000;
  const k = key(chainId, borrower);
  const entry = fallbackStore.get(k);
  if (!entry || entry.expiresAt <= now) {
    const next: FallbackEntry = { count: 1, expiresAt };
    fallbackStore.set(k, next);
    return next.count;
  }
  entry.count += 1;
  entry.expiresAt = Math.max(entry.expiresAt, expiresAt);
  fallbackStore.set(k, entry);
  return entry.count;
}

function fallbackReset(chainId: number, borrower: `0x${string}`): void {
  fallbackStore.delete(key(chainId, borrower));
}

export async function isThrottled(
  chainId: number,
  borrower: `0x${string}`,
  limit: number
): Promise<boolean> {
  if (limit <= 0) return false;
  if (fallbackEnabled || !redis) {
    return fallbackCount(chainId, borrower) >= limit;
  }
  try {
    const count = await redis.get(key(chainId, borrower));
    return count !== null && Number(count) >= limit;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'throttle-check-failed');
    enableFallback(err as Error);
    return fallbackCount(chainId, borrower) >= limit;
  }
}

export async function recordAttempt(
  chainId: number,
  borrower: `0x${string}`,
  windowSec = DEFAULT_WINDOW_SEC
): Promise<number | null> {
  if (fallbackEnabled || !redis) {
    return fallbackIncrement(chainId, borrower, windowSec);
  }
  try {
    const k = key(chainId, borrower);
    const results = await redis
      .multi()
      .incr(k)
      .expire(k, windowSec, 'NX')
      .exec();

    if (!results) return null;
    const countEntry = results[0];
    const count = countEntry?.[1];
    if (typeof count === 'number') return count;
    if (typeof count === 'string') return Number(count);
    return null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'throttle-incr-failed');
    enableFallback(err as Error);
    return fallbackIncrement(chainId, borrower, windowSec);
  }
}

export async function resetThrottle(chainId: number, borrower: `0x${string}`): Promise<void> {
  if (fallbackEnabled || !redis) {
    fallbackReset(chainId, borrower);
    return;
  }
  try {
    await redis.del(key(chainId, borrower));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'throttle-reset-failed');
    enableFallback(err as Error);
    fallbackReset(chainId, borrower);
  }
}
