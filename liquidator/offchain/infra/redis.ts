import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;

export const redis = redisUrl ? new Redis(redisUrl) : null;
