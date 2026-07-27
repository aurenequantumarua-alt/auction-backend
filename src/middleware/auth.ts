import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { unauthorized, forbidden } from '../utils/http-error.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessTokenPayload;
  }
}

const extractToken = (req: FastifyRequest): string | null => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return null;
};

/**
 * Hard authentication — rejects with 401 if no valid token.
 */
export const requireAuth = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  const token = extractToken(req);
  if (!token) throw unauthorized();
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    req.user = payload;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
};

/**
 * Soft authentication — populates req.user when a token is present, never rejects.
 * Useful for endpoints whose response varies by auth state (e.g. watchlist flag on auctions).
 */
export const optionalAuth = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  const token = extractToken(req);
  if (!token) return;
  try {
    req.user = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch {
    // Token is bad — pretend they're anonymous.
  }
};

export const requireAdmin = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
  if (!req.user) throw unauthorized();
  if (req.user.role !== 'ADMIN') throw forbidden('Admin access required');
};
