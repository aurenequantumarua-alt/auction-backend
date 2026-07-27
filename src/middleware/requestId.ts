import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

export const registerRequestId = (app: FastifyInstance): void => {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && incoming ? incoming : randomUUID();
    req.id = id;
    reply.header('x-request-id', id);
  });
};
