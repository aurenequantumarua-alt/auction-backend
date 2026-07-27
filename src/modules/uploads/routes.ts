import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.js';
import { storage } from '../../lib/storage.js';
import { badRequest } from '../../utils/http-error.js';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
]);
const MAX_BYTES = 8 * 1024 * 1024;

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
    const stored = await storage.put(buffer, file.filename, file.mimetype);
    return stored;
  });
};
