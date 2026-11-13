import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

// Accept client-provided request IDs only if they match a safe format and length
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

export const registerRequestId = (app: FastifyInstance): void => {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
        ? incoming
        : randomUUID();
    req.id = id;
    reply.header('x-request-id', id);
  });
};
