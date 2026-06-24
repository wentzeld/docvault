import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { tokens } from '../../db/schema.js';
import { requireAdmin } from '../middleware/requireAuth.js';
import { Errors } from '../lib/errors.js';
import { generateBearerToken } from '../lib/crypto.js';

const CreateTokenSchema = z.object({
  name: z.string().min(1).max(100),
  agent_id: z.string().min(1).max(100),
  scopes: z.array(z.string()).default(['read', 'write']),
  expires_at: z.string().optional(),
});

export async function tokenRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/tokens — create bearer token
  fastify.post(
    '/tokens',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = CreateTokenSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const raw = generateBearerToken();
      const hash = await bcrypt.hash(raw, 12);
      const lookupHash = createHash('sha256').update(raw).digest('hex');

      const expiresAt = body.data.expires_at
        ? new Date(body.data.expires_at)
        : null;

      const [token] = await fastify.db
        .insert(tokens)
        .values({
          name: body.data.name,
          agent_id: body.data.agent_id,
          hash,
          lookup_hash: lookupHash,
          scopes: body.data.scopes,
          expires_at: expiresAt ?? undefined,
          revoked: false,
        })
        .returning();

      if (!token) {
        return reply.status(500).send(Errors.internalError());
      }

      return reply.status(201).send({
        id: token.id,
        token: raw, // shown ONCE
        name: token.name,
        agent_id: token.agent_id,
        scopes: token.scopes,
        ...(token.expires_at ? { expires_at: token.expires_at.toISOString() } : {}),
        created: token.created_at.toISOString(),
      });
    }
  );

  // GET /api/v1/tokens — list tokens
  fastify.get(
    '/tokens',
    { preHandler: requireAdmin },
    async (_request, reply) => {
      const rows = await fastify.db
        .select({
          id: tokens.id,
          name: tokens.name,
          agent_id: tokens.agent_id,
          scopes: tokens.scopes,
          last_used_at: tokens.last_used_at,
          expires_at: tokens.expires_at,
          revoked: tokens.revoked,
          created_at: tokens.created_at,
        })
        .from(tokens);

      return reply.send({
        data: rows.map((t) => ({
          id: t.id,
          name: t.name,
          agent_id: t.agent_id,
          scopes: t.scopes,
          ...(t.last_used_at ? { last_used_at: t.last_used_at.toISOString() } : {}),
          ...(t.expires_at ? { expires_at: t.expires_at.toISOString() } : {}),
          revoked: t.revoked,
          created: t.created_at.toISOString(),
        })),
      });
    }
  );

  // DELETE /api/v1/tokens/:id — revoke token
  fastify.delete<{ Params: { id: string } }>(
    '/tokens/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { id } = request.params;

      const [existing] = await fastify.db
        .select({ id: tokens.id })
        .from(tokens)
        .where(eq(tokens.id, id))
        .limit(1);

      if (!existing) {
        return reply.status(404).send(Errors.notFound('Token'));
      }

      await fastify.db
        .update(tokens)
        .set({ revoked: true })
        .where(eq(tokens.id, id));

      return reply.status(204).send();
    }
  );
}
