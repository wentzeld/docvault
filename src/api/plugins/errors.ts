import type { FastifyInstance, FastifyError } from 'fastify';
import fp from 'fastify-plugin';
import type { ApiError } from '../lib/errors.js';

async function errorsPlugin(fastify: FastifyInstance): Promise<void> {
  fastify.setErrorHandler(
    (error: FastifyError | Error, _request, reply) => {
      // Already formatted API errors
      if ('status' in error && 'error' in error && 'detail' in error) {
        const apiErr = error as unknown as ApiError;
        return reply.status(apiErr.status).send(apiErr);
      }

      // Fastify validation errors
      if ('validation' in error && error.statusCode === 400) {
        return reply.status(400).send({
          status: 400,
          error: 'validation_error',
          detail: (error as FastifyError).message,
        });
      }

      // Fastify rate limit errors
      if ((error as FastifyError).statusCode === 429) {
        return reply.status(429).send({
          status: 429,
          error: 'rate_limited',
          detail: 'Too many requests',
        });
      }

      // Body too large
      if ((error as FastifyError).statusCode === 413) {
        return reply.status(413).send({
          status: 413,
          error: 'payload_too_large',
          detail: 'Request body too large',
        });
      }

      fastify.log.error(error);

      return reply.status(500).send({
        status: 500,
        error: 'internal_error',
        detail: 'An unexpected error occurred',
      });
    }
  );
}

export default fp(errorsPlugin, { name: 'errors' });
