import { Queue } from 'bullmq';
import { createBullConnection, redisAvailable } from '../lib/redis.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { logger } from '../lib/logger.js';

let auctionQueue: Queue | null = null;
let settlQueue: Queue | null = null;

try {
  const connection = createBullConnection();
  auctionQueue = new Queue(QUEUE_NAMES.auctionLifecycle, { connection });
  settlQueue = new Queue(QUEUE_NAMES.settlement, { connection });
} catch (err) {
  logger.warn('BullMQ queues could not be initialized — queue features disabled');
}

/** Proxy that silently no-ops when Redis/BullMQ is unavailable. */
const safeQueue = (q: Queue | null): Queue =>
  new Proxy({} as Queue, {
    get(_target, prop, receiver) {
      if (!q || !redisAvailable) {
        // Return a no-op function for any method call
        return (..._args: unknown[]) => {
          logger.debug(`Queue method ${String(prop)} called but Redis is unavailable`);
          return Promise.resolve(undefined);
        };
      }
      const orig = Reflect.get(q, prop, receiver);
      if (typeof orig === 'function') {
        return async (...args: unknown[]) => {
          if (!redisAvailable) {
            logger.debug(`Queue method ${String(prop)} called but Redis is unavailable`);
            return undefined;
          }
          try {
            return await orig.apply(q, args);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn({ err: message }, `Queue method ${String(prop)} failed — degrading gracefully`);
            return undefined;
          }
        };
      }
      return orig;
    },
  });

export const auctionLifecycleQueue: Queue = safeQueue(auctionQueue);
export const settlementQueue: Queue = safeQueue(settlQueue);
