import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  // Interactive transactions run several queries (e.g. settlement + wallet credit).
  // The default 5s timeout is too tight for a high-latency/remote DB (e.g. a Neon
  // region far from the server), so give transactions more headroom.
  transactionOptions: { maxWait: 15_000, timeout: 30_000 },
});

export type Prisma = typeof prisma;
