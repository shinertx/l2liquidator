import Redis from 'ioredis';
import { log } from './logger';

const redisUrl = process.env.REDIS_URL;

let client: Redis | null = null;
if (redisUrl) {
  try {
    const r = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
      connectTimeout: 500,
    });
    // Prevent unhandled error events from crashing logs
    r.on('error', (err) => {
      try {
        log.warn({ err: (err as Error).message }, 'redis-error');
      } catch {}
    });
    client = r;
  } catch (err) {
    try {
      log.warn({ err: (err as Error).message }, 'redis-init-failed');
    } catch {}
    client = null;
  }
}

export const redis = client;
