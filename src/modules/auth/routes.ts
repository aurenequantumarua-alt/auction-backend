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
  // Return refreshToken in body as well so the frontend can store it and
  // send it back on refresh. This avoids relying on cross-origin cookies
  // which are blocked by modern browsers (Chrome 118+ third-party cookie
  // phase-out). The httpOnly cookie is still set as a fallback.
  return reply.send({
    user: result.user,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
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

  // Accept refresh token from EITHER the httpOnly cookie (preferred) or the
  // request body (fallback). Modern Chrome blocks third-party cookies on
  // cross-origin deployments (Vercel → Render), so the body fallback is
  // essential for production.
  app.post('/auth/refresh', async (req, reply) => {
    const raw =
      req.cookies[REFRESH_COOKIE] ||
      (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    if (!raw) {
      reply.status(401).send({ error: { code: 'unauthorized', message: 'No refresh token present' } });
      return;
    }
    const result = await authService.refresh(raw, req.headers['user-agent']);
    return respondAuth(reply, result);
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw =
      req.cookies[REFRESH_COOKIE] ||
      (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    await authService.logout(raw);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const me = await authService.me(req.user!.sub);
    return { user: me };
  });
};
