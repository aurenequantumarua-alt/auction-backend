import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.js';
import { storage } from '../../lib/storage.js';
import { env } from '../../config/env.js';
import { badRequest } from '../../utils/http-error.js';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Validates the file buffer magic bytes against the claimed image MIME type
 * to prevent disguised executable/HTML/SVG files from being uploaded.
 */
const isValidImageMagicBytes = (buf: Buffer, mime: string): boolean => {
  if (buf.length < 12) return false;
  if (mime === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mime === 'image/png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }
  if (mime === 'image/webp') {
    return (
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    );
  }
  if (mime === 'image/avif') {
    return buf.toString('ascii', 4, 8) === 'ftyp';
  }
  return false;
};

export const registerUploadRoutes = async (app: FastifyInstance): Promise<void> => {
  app.post('/uploads/image', { preHandler: requireAuth }, async (req) => {
    const file = await req.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
    if (!file) throw badRequest('Expected a multipart file field');
    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw badRequest(`Unsupported file type: ${file.mimetype}`);
    }
    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      throw badRequest('File exceeds 8 MB limit');
    }
    if (!isValidImageMagicBytes(buffer, file.mimetype)) {
      throw badRequest('File content does not match the image format signature');
    }
    const stored = await storage.put(buffer, file.filename, file.mimetype);
    if (env.STORAGE_DRIVER === 's3') {
      return stored;
    }
    // If the configured uploads URL is still localhost but the request is coming via a deployed host (e.g. Render),
    // ensure the returned URL uses the request's public HTTPS protocol and host so browsers don't block Mixed Content.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) || req.protocol;
    if (host && env.PUBLIC_UPLOADS_BASE_URL.includes('localhost') && !host.includes('localhost')) {
      return {
        key: stored.key,
        url: `${proto}://${host}/uploads/${stored.key}`,
      };
    }
    return stored;
  });
};
