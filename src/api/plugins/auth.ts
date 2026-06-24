import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { eq, and, isNull, gt, sql } from 'drizzle-orm';
import { tokens, sessions } from '../../db/schema.js';
import { config } from '../../config.js';

async function authPlugin(fastify: FastifyInstance): Promise<void> {
  // Decorate with verify functions accessible to routes
  fastify.decorate(
    'verifyBearerToken',
    async (token: string) => {
      const lookupHash = createHash('sha256').update(token).digest('hex');

      const rows = await fastify.db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.lookup_hash, lookupHash),
            eq(tokens.revoked, false),
            // expires_at IS NULL OR expires_at > now()
            sql`(${tokens.expires_at} IS NULL OR ${tokens.expires_at} > now())`
          )
        )
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const valid = await bcrypt.compare(token, row.hash);
      if (!valid) return null;

      // Fire-and-forget last_used_at update
      fastify.db
        .update(tokens)
        .set({ last_used_at: sql`now()` })
        .where(eq(tokens.id, row.id))
        .execute()
        .catch(() => {});

      return row;
    }
  );

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  fastify.decorate(
    'verifySession',
    async (sessionId: string) => {
      // A malformed session cookie (any non-UUID value) previously reached
      // Postgres, which threw "invalid input syntax for type uuid" → 500 on
      // every authenticated request. Treat it as "no session" instead.
      if (!UUID_RE.test(sessionId)) return null;
      const rows = await fastify.db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.id, sessionId),
            gt(sessions.expires_at, sql`now()`)
          )
        )
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      // Slide expiry
      const newExpiry = new Date(
        Date.now() + config.auth.session_ttl_seconds * 1000
      );
      fastify.db
        .update(sessions)
        .set({ expires_at: newExpiry, last_seen_at: sql`now()` })
        .where(eq(sessions.id, sessionId))
        .execute()
        .catch(() => {});

      return row;
    }
  );
}

export default fp(authPlugin, { name: 'auth' });

// Augment FastifyInstance with our decorations
declare module 'fastify' {
  interface FastifyInstance {
    verifyBearerToken: (
      token: string
    ) => Promise<import('../../db/schema.js').Token | null>;
    verifySession: (
      sessionId: string
    ) => Promise<import('../../db/schema.js').Session | null>;
  }
}
