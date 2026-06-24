import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { agents } from '../../db/schema.js';
import { requireAuth, requireAdmin } from '../middleware/requireAuth.js';
import { Errors } from '../lib/errors.js';
import {
  generateWebhookSecret,
  encryptSecret,
} from '../lib/crypto.js';
import { validateWebhookUrl } from '../lib/webhook.js';
import { config } from '../../config.js';

const CreateAgentSchema = z.object({
  id: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  webhook_url: z.string().url().optional(),
  webhook_events: z.array(z.string()).optional().default([]),
});

const UpdateAgentSchema = z.object({
  webhook_url: z.string().url().optional(),
  webhook_events: z.array(z.string()).optional(),
  active: z.boolean().optional(),
});

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/agents — create agent
  fastify.post(
    '/agents',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const body = CreateAgentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      // Check for duplicate agent ID
      const [existing] = await fastify.db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, body.data.id))
        .limit(1);

      if (existing) {
        return reply.status(409).send({
          status: 409,
          error: 'conflict',
          detail: `Agent ID '${body.data.id}' already exists`,
        });
      }

      if (body.data.webhook_url) {
        const urlCheck = validateWebhookUrl(body.data.webhook_url);
        if (!urlCheck.valid) {
          return reply.status(400).send({
            status: 400,
            error: 'invalid_webhook_url',
            detail: urlCheck.reason,
          });
        }
      }

      const secretKey = config.auth.secret_key;
      if (!secretKey) {
        return reply.status(500).send(
          Errors.internalError('DOCVAULT_AUTH_SECRET_KEY not configured')
        );
      }

      let rawSecret: string | undefined;
      let secretEnc: string | undefined;

      if (body.data.webhook_url) {
        rawSecret = generateWebhookSecret();
        secretEnc = encryptSecret(rawSecret, secretKey);
      }

      const [agent] = await fastify.db
        .insert(agents)
        .values({
          id: body.data.id,
          webhook_url: body.data.webhook_url ?? null,
          webhook_secret_enc: secretEnc ?? null,
          webhook_events: body.data.webhook_events,
          active: true,
        })
        .returning();

      const response: Record<string, unknown> = {
        id: agent!.id,
        webhook_events: agent!.webhook_events,
        active: agent!.active,
        created: agent!.created_at.toISOString(),
      };
      if (agent!.webhook_url) response['webhook_url'] = agent!.webhook_url;
      if (rawSecret) {
        response['webhook_secret'] = rawSecret; // shown ONCE
      }

      return reply.status(201).send(response);
    }
  );

  // GET /api/v1/agents — list agents
  fastify.get(
    '/agents',
    { preHandler: requireAdmin },
    async (_request, reply) => {
      const rows = await fastify.db
        .select({
          id: agents.id,
          webhook_url: agents.webhook_url,
          webhook_events: agents.webhook_events,
          active: agents.active,
          created_at: agents.created_at,
        })
        .from(agents);

      return reply.send({
        data: rows.map((a) => ({
          id: a.id,
          ...(a.webhook_url ? { webhook_url: a.webhook_url } : {}),
          webhook_events: a.webhook_events,
          active: a.active,
          created: a.created_at.toISOString(),
        })),
      });
    }
  );

  // PATCH /api/v1/agents/:agentId — update agent
  fastify.patch<{ Params: { agentId: string } }>(
    '/agents/:agentId',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { agentId } = request.params;
      const body = UpdateAgentSchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const [existing] = await fastify.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!existing) {
        return reply.status(404).send(Errors.notFound('Agent'));
      }

      if (body.data.webhook_url !== undefined) {
        const urlCheck = validateWebhookUrl(body.data.webhook_url);
        if (!urlCheck.valid) {
          return reply.status(400).send({
            status: 400,
            error: 'invalid_webhook_url',
            detail: urlCheck.reason,
          });
        }
      }

      const updates: Partial<typeof agents.$inferInsert> = {
        updated_at: new Date(),
      };

      if (body.data.webhook_url !== undefined) {
        updates.webhook_url = body.data.webhook_url;
        // Generate new secret if URL is being set for the first time
        if (!existing.webhook_url && body.data.webhook_url) {
          const secretKey = config.auth.secret_key;
          if (secretKey) {
            const rawSecret = generateWebhookSecret();
            updates.webhook_secret_enc = encryptSecret(rawSecret, secretKey);
          }
        }
      }
      if (body.data.webhook_events !== undefined) {
        updates.webhook_events = body.data.webhook_events;
      }
      if (body.data.active !== undefined) updates.active = body.data.active;

      const [updated] = await fastify.db
        .update(agents)
        .set(updates)
        .where(eq(agents.id, agentId))
        .returning();

      return reply.send({
        id: updated!.id,
        ...(updated!.webhook_url ? { webhook_url: updated!.webhook_url } : {}),
        webhook_events: updated!.webhook_events,
        active: updated!.active,
        updated: updated!.updated_at.toISOString(),
      });
    }
  );

  // POST /api/v1/agents/:agentId/rotate-secret
  fastify.post<{ Params: { agentId: string } }>(
    '/agents/:agentId/rotate-secret',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { agentId } = request.params;

      const [existing] = await fastify.db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!existing) {
        return reply.status(404).send(Errors.notFound('Agent'));
      }

      const secretKey = config.auth.secret_key;
      if (!secretKey) {
        return reply.status(500).send(
          Errors.internalError('DOCVAULT_AUTH_SECRET_KEY not configured')
        );
      }

      const rawSecret = generateWebhookSecret();
      const secretEnc = encryptSecret(rawSecret, secretKey);

      await fastify.db
        .update(agents)
        .set({ webhook_secret_enc: secretEnc, updated_at: new Date() })
        .where(eq(agents.id, agentId));

      return reply.send({ webhook_secret: rawSecret });
    }
  );
}
