import { redis } from './redis';
import { log } from './logger';

const DEFAULT_TTL_SEC = 7200; // 2 hours

function key(chainId: number, borrower: `0x${string}`) {
  return `borrower:intel:${chainId}:${borrower.toLowerCase()}`;
}

export type BorrowerIntel = {
  healthFactor: number;
  updatedAt: number;
};

const fallbackStore = new Map<string, BorrowerIntel>();
let fallbackEnabled = false;

function enableFallback(err?: Error) {
  if (!fallbackEnabled) {
    fallbackEnabled = true;
    log.warn({ err: err?.message }, 'borrower-intel-fallback-enabled');
  }
}

function fallbackGet(chainId: number, borrower: `0x${string}`): BorrowerIntel | null {
  const entry = fallbackStore.get(key(chainId, borrower));
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > DEFAULT_TTL_SEC * 1000) {
    fallbackStore.delete(key(chainId, borrower));
    return null;
  }
  return entry;
}

function fallbackSet(chainId: number, borrower: `0x${string}`, intel: BorrowerIntel): void {
  fallbackStore.set(key(chainId, borrower), intel);
}

export async function loadBorrowerIntel(
  chainId: number,
  borrower: `0x${string}`
): Promise<BorrowerIntel | null> {
  if (fallbackEnabled || !redis) {
    return fallbackGet(chainId, borrower);
  }
  try {
    const raw = await redis.get(key(chainId, borrower));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BorrowerIntel;
    if (!Number.isFinite(parsed.healthFactor)) return null;
    return parsed;
  } catch (err) {
    enableFallback(err as Error);
    return fallbackGet(chainId, borrower);
  }
}

export async function storeBorrowerIntel(
  chainId: number,
  borrower: `0x${string}`,
  healthFactor: number,
  ttlSec = DEFAULT_TTL_SEC
): Promise<void> {
  if (!Number.isFinite(healthFactor) || healthFactor <= 0) return;
  const payload: BorrowerIntel = { healthFactor, updatedAt: Date.now() };
  if (fallbackEnabled || !redis) {
    fallbackSet(chainId, borrower, payload);
    return;
  }
  try {
    await redis.set(key(chainId, borrower), JSON.stringify(payload), 'EX', ttlSec);
  } catch (err) {
    enableFallback(err as Error);
    fallbackSet(chainId, borrower, payload);
  }
}
