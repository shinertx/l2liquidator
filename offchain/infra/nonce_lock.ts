import { randomUUID } from 'crypto';
import { redis } from './redis';
import { log } from './logger';

const localLocks = new Map<string, Promise<void>>();

const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_MS = 100;

async function acquireLocalLock(key: string) {
  let release = () => {};
  while (true) {
    if (!localLocks.has(key)) {
      let resolveFn: (() => void) | null = null;
      const p = new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
      release = () => {
        if (resolveFn) resolveFn();
      };
      localLocks.set(key, p);
      break;
    }
    await localLocks.get(key);
  }
  return () => {
    release();
    localLocks.delete(key);
  };
}

async function acquireDistributedLock(key: string) {
  if (!redis) {
    return acquireLocalLock(key);
  }

  const token = randomUUID();
  const lockKey = `nonce-lock:${key}`;
  const client = redis!;
  while (true) {
    const ok = await client.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX');
    if (ok) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }

  const release = async () => {
    try {
      const current = await client.get(lockKey);
      if (current === token) {
        await client.del(lockKey);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, lockKey }, 'nonce-lock-release-failed');
    }
  };

  return release;
}

export async function withNonceLock<T>(chainId: number, address: string, fn: () => Promise<T>): Promise<T> {
  const key = `${chainId}:${address.toLowerCase()}`;
  const release = await acquireDistributedLock(key);
  try {
    return await fn();
  } finally {
    await release();
  }
}
