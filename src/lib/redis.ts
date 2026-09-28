import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Whether Redis is available. When false, BullMQ queues and workers are
 * no-ops so the core HTTP API still works without a local Redis instance.
 */
export let redisAvailable = true;

const createConnection = (opts?: { maxRetriesPerRequest: null }): Redis => {
  const isTls = env.REDIS_URL.startsWith('rediss://');
  const conn = new IORedis(env.REDIS_URL, {
    ...opts,
    lazyConnect: true,
    ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
    retryStrategy(times) {
      if (times > 3) {
        // Stop retrying after 3 attempts — Redis is down.
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  });

  conn.on('error', (err) => {
    if (redisAvailable) {
      logger.warn({ err: err.message }, 'Redis unavailable — queue features disabled');
      redisAvailable = false;
    }
  });

  conn.on('connect', () => {
    redisAvailable = true;
  });

  return conn;
};

// BullMQ requires `maxRetriesPerRequest: null` on its connection.
export const createBullConnection = (): Redis =>
  createConnection({ maxRetriesPerRequest: null });

// General-purpose Redis client (caching, pub/sub, etc.).
export const redis: Redis = createConnection();
