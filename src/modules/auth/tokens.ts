import jwt, { type SignOptions } from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import type { AccessTokenPayload } from '../../middleware/auth.js';

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
  } as SignOptions);

export interface IssuedRefreshToken {
  raw: string;
  hash: string;
  expiresAt: Date;
}

/**
 * Refresh tokens are random opaque strings. We store only the SHA-256 hash in
 * the database — even a full DB compromise does not leak usable tokens.
 */
export const issueRefreshToken = (): IssuedRefreshToken => {
  const raw = randomBytes(48).toString('base64url');
  const hash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  return { raw, hash, expiresAt };
};

export const hashRefreshToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');
