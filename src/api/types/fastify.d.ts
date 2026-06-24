import 'fastify';
import type { DbClient } from '../../db/index.js';
import type PgBoss from 'pg-boss';

declare module 'fastify' {
  interface FastifyInstance {
    db: DbClient;
    boss: PgBoss;
  }

  interface FastifyRequest {
    user?: {
      type: 'token' | 'session';
      agentId?: string;
      username?: string;
      tokenId?: string;
      scopes?: string[];
    };
  }
}
