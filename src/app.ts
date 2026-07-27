import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { registerRequestId } from './middleware/requestId.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerAuctionRoutes } from './modules/auctions/routes.js';
import { registerBidRoutes } from './modules/bids/routes.js';
import { registerWatchlistRoutes } from './modules/watchlist/routes.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import { registerPaymentRoutes, handleRazorpayWebhook } from './modules/payments/routes.js';
import { registerUploadRoutes } from './modules/uploads/routes.js';
import { registerWalletRoutes } from './modules/wallet/routes.js';
import { registerBankAccountRoutes } from './modules/bankAccounts/routes.js';
import { registerWithdrawalRoutes } from './modules/withdrawals/routes.js';
import { registerAdminRoutes } from './modules/admin/routes.js';
import { registerReportRoutes } from './modules/reports/routes.js';

export const buildApp = async (): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 12 * 1024 * 1024,
    disableRequestLogging: true,
  });

  app.setErrorHandler(errorHandler);
  registerRequestId(app);

  app.addHook('onResponse', async (req, reply) => {
    logger.debug(
      {
        reqId: req.id,
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
      },
      'http',
    );
  });

  // Security headers (HSTS, nosniff, frameguard, referrer-policy, no x-powered-by).
  // CSP is disabled here because this is a JSON API + static uploads consumed by a
  // separate frontend origin; the SPA carries its own CSP. CORP is relaxed so the
  // frontend can load /uploads images cross-origin.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: true,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 200,
    timeWindow: 60_000,
  });
  await app.register(multipart, {
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  });

  // Local uploads directory served statically (dev only — use a CDN in prod).
  if (env.STORAGE_DRIVER === 'local') {
    const uploadsRoot = resolve(env.UPLOADS_DIR);
    if (!existsSync(uploadsRoot)) mkdirSync(uploadsRoot, { recursive: true });
    await app.register(fastifyStatic, {
      root: uploadsRoot,
      prefix: '/uploads/',
      decorateReply: false,
    });
  }

  // Health check
  app.get('/health', async () => ({ ok: true, version: '0.1.0' }));

  // API surface — versioned at /api/v1 for future-proofing.
  await app.register(
    async (api) => {
      await registerAuthRoutes(api);
      await registerUserRoutes(api);
      await registerAuctionRoutes(api);
      await registerBidRoutes(api);
      await registerWatchlistRoutes(api);
      await registerNotificationRoutes(api);
      await registerPaymentRoutes(api);
      await registerUploadRoutes(api);
      await registerWalletRoutes(api);
      await registerBankAccountRoutes(api);
      await registerWithdrawalRoutes(api);
      await registerReportRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  await app.register(
    async (api) => {
      await registerAdminRoutes(api);
    },
    { prefix: '/api/v1/admin' },
  );

  // Razorpay webhook — encapsulated so it receives the RAW body (the HMAC must be
  // verified against the exact bytes). Its content-type parser is local to this
  // plugin and does not affect the JSON parsing of the main API above.
  await app.register(
    async (hook) => {
      hook.addContentTypeParser(
        'application/json',
        { parseAs: 'buffer' },
        (_req, body, done) => done(null, body),
      );
      hook.post('/webhooks/razorpay', async (req, reply) => {
        const signature = req.headers['x-razorpay-signature'] as string | undefined;
        try {
          return await handleRazorpayWebhook(req.body as Buffer, signature);
        } catch {
          // Bad signature / malformed payload — 400. Razorpay will retry valid ones.
          reply.code(400);
          return { ok: false };
        }
      });
    },
    { prefix: '/api/v1' },
  );

  return app;
};
