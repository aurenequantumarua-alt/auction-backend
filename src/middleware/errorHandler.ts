import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from '../utils/http-error.js';
import { logger } from '../lib/logger.js';

export const errorHandler = (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void => {
  if (error instanceof ZodError) {
    reply.status(422).send({
      error: {
        code: 'validation_failed',
        message: 'Request payload failed validation',
        details: error.flatten(),
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    reply.status(error.statusCode).send({
      error: { code: error.code ?? 'http_error', message: error.message },
    });
    return;
  }

  logger.error(
    { err: error, requestId: request.id, url: request.url, method: request.method },
    'Unhandled error',
  );

  reply.status(500).send({
    error: {
      code: 'internal_error',
      message: 'Something went wrong. Please try again.',
    },
  });
};
