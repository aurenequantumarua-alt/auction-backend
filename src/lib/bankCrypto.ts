import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * AES-256-GCM encryption for at-rest bank account numbers.
 *
 * The key is BANK_ENCRYPTION_KEY (64 hex chars -> 32 bytes) when provided,
 * otherwise it is derived deterministically from JWT_ACCESS_SECRET so the app
 * works out of the box. The stored ciphertext layout is:
 *
 *     <iv hex>:<authTag hex>:<ciphertext hex>
 *
 * Each call uses a fresh random IV; the GCM auth tag is verified on decrypt so
 * tampering throws.
 */
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

const resolveKey = (): Buffer => {
  const hex = env.BANK_ENCRYPTION_KEY?.trim();
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('BANK_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }
    return Buffer.from(hex, 'hex');
  }
  return crypto.createHash('sha256').update(env.JWT_ACCESS_SECRET).digest();
};

const KEY = resolveKey();

export const encrypt = (plaintext: string): string => {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
};

export const decrypt = (stored: string): string => {
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('Malformed ciphertext');
  const [ivHex, tagHex, dataHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

export const last4 = (num: string): string => num.slice(-4);
