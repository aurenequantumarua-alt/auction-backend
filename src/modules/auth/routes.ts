import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middleware/auth.js';
import { LoginSchema, SignupSchema, ForgotPasswordSchema, ResetPasswordSchema } from './dto.js';
import { authService, type AuthResult } from './service.js';

const REFRESH_COOKIE = 'aurene_refresh';

const refreshCookieOptions = (expires: Date) => ({
  path: '/',
  httpOnly: true,
  sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
  secure: env.NODE_ENV === 'production' || env.COOKIE_SECURE,
  ...(env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost' ? { domain: env.COOKIE_DOMAIN } : {}),
  expires,
});

const setSessionCookie = (reply: import('fastify').FastifyReply, result: AuthResult) => {
  reply.setCookie(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions(result.refreshExpiresAt));
};

const clearSessionCookie = (reply: import('fastify').FastifyReply) => {
  reply.clearCookie(REFRESH_COOKIE, {
    path: '/',
    sameSite: (env.NODE_ENV === 'production' ? 'none' : 'lax') as 'none' | 'lax',
    secure: env.NODE_ENV === 'production' || env.COOKIE_SECURE,
    ...(env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost' ? { domain: env.COOKIE_DOMAIN } : {}),
  });
};

const respondAuth = (reply: import('fastify').FastifyReply, result: AuthResult) => {
  setSessionCookie(reply, result);
  return reply.send({
    user: result.user,
    accessToken: result.accessToken,
    expiresAt: result.refreshExpiresAt.toISOString(),
  });
};

export const registerAuthRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/auth/signup', {
    config: {
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW_MS },
    },
    handler: async (req, reply) => {
      const dto = SignupSchema.parse(req.body);
      const result = await authService.signup(dto, req.headers['user-agent']);
      if ('requiresEmailVerification' in result) {
        return reply.send(result);
      }
      return respondAuth(reply, result);
    },
  });

  app.post('/auth/login', {
    config: {
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW_MS },
    },
    handler: async (req, reply) => {
      const dto = LoginSchema.parse(req.body);
      const result = await authService.login(dto, req.headers['user-agent']);
      if ('requiresEmailVerification' in result) {
        return reply.send(result);
      }
      return respondAuth(reply, result);
    },
  });

  app.post('/auth/forgot-password', {
    config: {
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW_MS },
    },
    handler: async (req, reply) => {
      const dto = ForgotPasswordSchema.parse(req.body);
      const result = await authService.forgotPassword(dto.email);
      return reply.send(result);
    },
  });

  app.post('/auth/reset-password', {
    config: {
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW_MS },
    },
    handler: async (req, reply) => {
      const dto = ResetPasswordSchema.parse(req.body);
      const result = await authService.resetPassword(dto, req.headers['user-agent']);
      return respondAuth(reply, result);
    },
  });

  app.post('/auth/verify-email', {
    config: {
      rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW_MS },
    },
    handler: async (req, reply) => {
      const body = req.body as { email: string; code: string };
      if (!body.email || !body.code) {
        reply.status(400).send({ error: { code: 'bad_request', message: 'Email and code are required' } });
        return;
      }
      const result = await authService.verifyEmail(body.email, body.code, req.headers['user-agent']);
      return respondAuth(reply, result);
    },
  });

  app.post('/auth/refresh', async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) {
      reply.status(401).send({ error: { code: 'unauthorized', message: 'No refresh token present' } });
      return;
    }
    const result = await authService.refresh(raw, req.headers['user-agent']);
    return respondAuth(reply, result);
  });

  app.post('/auth/logout', async (req, reply) => {
    await authService.logout(req.cookies[REFRESH_COOKIE]);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const me = await authService.me(req.user!.sub);
    return { user: me };
  });
};
