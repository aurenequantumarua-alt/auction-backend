import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './jobs/workers.js';
import { startReconciler } from './jobs/reconciler.js';
import { initRealtime } from './realtime/gateway.js';
import { prisma } from './lib/prisma.js';

const main = async () => {
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  // The HTTP server backs the Socket.IO instance — they share the same port.
  initRealtime(app.server);
  const workers = startWorkers();
  const reconciler = startReconciler();

  logger.info(`Aurene API listening on http://${env.HOST}:${env.PORT}`);

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    try {
      reconciler.stop();
      await workers.close();
      await app.close();
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
