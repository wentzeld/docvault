import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { getDb, getPool } from '../../db/index.js';

async function dbPlugin(fastify: FastifyInstance): Promise<void> {
  const db = getDb();
  fastify.decorate('db', db);

  fastify.addHook('onClose', async () => {
    await getPool().end();
  });
}

export default fp(dbPlugin, { name: 'db' });
