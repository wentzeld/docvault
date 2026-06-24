import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { requireAdmin } from '../middleware/requireAuth.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  // Public health check — returns only status for Caddy's health probe
  fastify.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // Admin-only detailed health check
  fastify.get(
    '/api/v1/admin/health',
    { preHandler: requireAdmin },
    async (_request, reply) => {
      let dbStatus = 'ok';
      let queueDepth = 0;

      try {
        await fastify.db.execute(sql`SELECT 1`);
      } catch {
        dbStatus = 'degraded';
      }

      let embeddingsStatus = 'degraded';
      try {
        const available = await fastify.workerClient.isAvailable();
        embeddingsStatus = available ? 'ok' : 'degraded';
      } catch {
        embeddingsStatus = 'degraded';
      }

      // Get queue depth from pg-boss
      try {
        const result = await fastify.db.execute(
          sql`SELECT COUNT(*) as count FROM pgboss.job WHERE name = 'embed-document' AND state = 'created'`
        );
        const rows = result.rows as Array<{ count: string }>;
        queueDepth = parseInt(rows[0]?.count ?? '0', 10);
      } catch {
        queueDepth = -1;
      }

      const status = dbStatus === 'ok' ? 200 : 503;
      return reply.status(status).send({
        status: dbStatus === 'ok' ? 'ok' : 'degraded',
        version: '1.0.0',
        db: dbStatus,
        embeddings: embeddingsStatus,
        queue_depth: queueDepth,
      });
    }
  );
}
