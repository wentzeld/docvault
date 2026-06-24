import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, isNull, sql, asc } from 'drizzle-orm';
import { documents, comments, commentReads, agents } from '../../db/schema.js';
import { requireAuth, requireWrite } from '../middleware/requireAuth.js';
import { Errors } from '../lib/errors.js';
import { dispatchWebhook } from '../lib/webhook.js';
import { sanitizeBody } from '../lib/markdown.js';

const SelectorSchema = z.object({
  quote: z.object({
    exact: z.string(),
    pre: z.string().default(''),
    post: z.string().default(''),
  }),
  pos: z.object({
    start: z.number().int().min(0),
    end: z.number().int().min(0),
  }),
});

const CreateCommentSchema = z.object({
  body: z.string().min(1).max(10000),
  type: z.enum(['inline', 'page']).default('page'),
  parent_id: z.string().uuid().optional(),
  selector: SelectorSchema.optional(),
  round: z.number().int().min(1).default(1),
  author: z.string().optional(),
});

const UpdateCommentSchema = z.object({
  body: z.string().min(1).max(10000).optional(),
  resolved: z.boolean().optional(),
});

const ListCommentsQuerySchema = z.object({
  round: z.coerce.number().int().optional(),
  resolved: z.coerce.boolean().optional(),
  author: z.string().optional(),
  group_by: z.enum(['author']).optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  nulls: z.coerce.boolean().default(false),
  unread_by: z.string().optional(),
});

function buildCommentResponse(
  comment: typeof comments.$inferSelect,
  opts: { includeNulls?: boolean } = {}
) {
  const base: Record<string, unknown> = {
    id: comment.id,
    doc: comment.doc_id,
    author: comment.author,
    type: comment.type,
    body: comment.body,
    round: comment.round,
    created: comment.created_at.toISOString(),
    updated: comment.updated_at.toISOString(),
  };

  if (opts.includeNulls) {
    base['parent'] = comment.parent_id ?? null;
    base['selector'] = comment.selector ?? null;
    base['resolved'] = comment.resolved;
    base['anchor_lost'] = comment.anchor_lost;
  } else {
    if (comment.parent_id) base['parent'] = comment.parent_id;
    if (comment.type === 'inline' && comment.selector) {
      base['selector'] = comment.selector;
    }
    if (comment.resolved) base['resolved'] = comment.resolved;
    if (comment.anchor_lost) base['anchor_lost'] = comment.anchor_lost;
  }

  return base;
}

export async function commentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/documents/:docId/comments
  fastify.post<{ Params: { docId: string } }>(
    '/documents/:docId/comments',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { docId } = request.params;
      const body = CreateCommentSchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      // Verify document exists
      const [doc] = await fastify.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, docId), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) {
        return reply.status(404).send(Errors.notFound('Document'));
      }

      // Validate parent comment belongs to same doc
      if (body.data.parent_id) {
        const [parent] = await fastify.db
          .select({ id: comments.id, doc_id: comments.doc_id })
          .from(comments)
          .where(
            and(
              eq(comments.id, body.data.parent_id),
              isNull(comments.deleted_at)
            )
          )
          .limit(1);

        if (!parent) {
          return reply.status(422).send(
            Errors.unprocessable('Parent comment not found')
          );
        }
        if (parent.doc_id !== docId) {
          return reply.status(422).send(
            Errors.unprocessable('Parent comment belongs to a different document')
          );
        }
      }

      // Inline type requires selector
      if (body.data.type === 'inline' && !body.data.selector) {
        return reply.status(400).send(
          Errors.validationError('Inline comments require a selector')
        );
      }

      // Identity is derived from the authenticated caller — a client cannot post
      // as someone else. Admins may set `author` explicitly (e.g. for the approve
      // flow or migrations); everyone else always posts as themselves.
      const callerId =
        request.user?.agentId ?? request.user?.username ?? 'unknown';
      const isAdmin = request.user?.scopes?.includes('admin') ?? false;
      const author =
        isAdmin && body.data.author ? body.data.author : callerId;

      const sanitizedBody = await sanitizeBody(body.data.body);

      const [comment] = await fastify.db
        .insert(comments)
        .values({
          doc_id: docId,
          parent_id: body.data.parent_id ?? null,
          author,
          type: body.data.type,
          body: sanitizedBody,
          selector: body.data.selector ?? null,
          round: body.data.round,
          resolved: false,
          anchor_lost: false,
        })
        .returning();

      if (!comment) {
        return reply.status(500).send(Errors.internalError());
      }

      // Update document commented_at
      await fastify.db
        .update(documents)
        .set({ commented_at: new Date() })
        .where(eq(documents.id, docId));

      // Dispatch webhooks for agents subscribed to comment.created
      try {
        const allAgents = await fastify.db
          .select()
          .from(agents)
          .where(eq(agents.active, true));

        for (const agent of allAgents) {
          if (
            agent.webhook_url &&
            agent.webhook_events.includes('comment.created')
          ) {
            // Fire-and-forget
            dispatchWebhook(agent, {
              event: 'comment.created',
              doc: docId,
              comment: comment.id,
              ts: new Date().toISOString(),
            }).catch((err) =>
              fastify.log.warn({ err }, 'Webhook dispatch failed')
            );
          }
        }
      } catch (err) {
        fastify.log.warn({ err }, 'Failed to fetch agents for webhook dispatch');
      }

      return reply
        .status(201)
        .send(buildCommentResponse(comment));
    }
  );

  // GET /api/v1/documents/:docId/comments
  fastify.get<{ Params: { docId: string } }>(
    '/documents/:docId/comments',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { docId } = request.params;
      const query = ListCommentsQuerySchema.safeParse(request.query);

      if (!query.success) {
        return reply.status(400).send(Errors.validationError(query.error.message));
      }

      // Verify document exists
      const [doc] = await fastify.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, docId), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) {
        return reply.status(404).send(Errors.notFound('Document'));
      }

      const q = query.data;

      // Build conditions
      const conditions = [
        eq(comments.doc_id, docId),
        isNull(comments.deleted_at),
      ];

      if (q.round !== undefined) {
        conditions.push(eq(comments.round, q.round));
      }
      if (q.resolved !== undefined) {
        conditions.push(eq(comments.resolved, q.resolved));
      }
      if (q.author) {
        conditions.push(eq(comments.author, q.author));
      }

      // Unread filter: comments not acknowledged by the specified agent
      if (q.unread_by) {
        const agentId = q.unread_by;
        conditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM comment_reads cr
            WHERE cr.comment_id = ${comments.id}
            AND cr.agent_id = ${agentId}
          )`
        );
      }

      // Cursor pagination
      if (q.after) {
        conditions.push(
          sql`${comments.created_at} > ${new Date(q.after)}::timestamptz`
        );
      }

      const rows = await fastify.db
        .select()
        .from(comments)
        .where(and(...conditions))
        .orderBy(asc(comments.created_at))
        .limit(q.limit + 1);

      const hasMore = rows.length > q.limit;
      const data = rows.slice(0, q.limit);
      const lastRow = data[data.length - 1];

      let nextCursor: string | undefined;
      if (hasMore && lastRow) {
        nextCursor = Buffer.from(
          JSON.stringify({
            created_at: lastRow.created_at.toISOString(),
            id: lastRow.id,
          })
        ).toString('base64');
      }

      if (q.group_by === 'author') {
        const grouped: Record<
          string,
          { author: string; comments: ReturnType<typeof buildCommentResponse>[] }
        > = {};
        for (const comment of data) {
          if (!grouped[comment.author]) {
            grouped[comment.author] = { author: comment.author, comments: [] };
          }
          grouped[comment.author]!.comments.push(
            buildCommentResponse(comment, { includeNulls: q.nulls })
          );
        }

        return reply.send({
          data: Object.values(grouped),
          ...(nextCursor ? { next: nextCursor } : {}),
        });
      }

      return reply.send({
        data: data.map((c) => buildCommentResponse(c, { includeNulls: q.nulls })),
        ...(nextCursor ? { next: nextCursor } : {}),
      });
    }
  );

  // PATCH /api/v1/documents/:docId/comments/:commentId
  fastify.patch<{ Params: { docId: string; commentId: string } }>(
    '/documents/:docId/comments/:commentId',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { docId, commentId } = request.params;
      const body = UpdateCommentSchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const [comment] = await fastify.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.id, commentId),
            eq(comments.doc_id, docId),
            isNull(comments.deleted_at)
          )
        )
        .limit(1);

      if (!comment) {
        return reply.status(404).send(Errors.notFound('Comment'));
      }

      // Authorization: only author or admin may edit
      const user = request.user!;
      const isAdmin = user.scopes?.includes('admin');
      const isAuthor =
        user.agentId === comment.author || user.username === comment.author;

      if (!isAdmin && !isAuthor) {
        return reply.status(403).send(Errors.forbidden('Only the author can edit this comment'));
      }

      const updates: Partial<typeof comments.$inferInsert> = {
        updated_at: new Date(),
      };
      // Sanitize on update too — keep the stored-body invariant (no raw HTML)
      // consistent with the create path.
      if (body.data.body !== undefined) updates.body = await sanitizeBody(body.data.body);
      if (body.data.resolved !== undefined) updates.resolved = body.data.resolved;

      const [updated] = await fastify.db
        .update(comments)
        .set(updates)
        .where(eq(comments.id, commentId))
        .returning();

      if (!updated) {
        return reply.status(500).send(Errors.internalError());
      }

      // Update document commented_at
      await fastify.db
        .update(documents)
        .set({ commented_at: new Date() })
        .where(eq(documents.id, docId));

      return reply.send(buildCommentResponse(updated));
    }
  );

  // DELETE /api/v1/documents/:docId/comments/:commentId
  fastify.delete<{ Params: { docId: string; commentId: string } }>(
    '/documents/:docId/comments/:commentId',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { docId, commentId } = request.params;

      const [comment] = await fastify.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.id, commentId),
            eq(comments.doc_id, docId),
            isNull(comments.deleted_at)
          )
        )
        .limit(1);

      if (!comment) {
        return reply.status(404).send(Errors.notFound('Comment'));
      }

      const user = request.user!;
      const isAdmin = user.scopes?.includes('admin');
      const isAuthor =
        user.agentId === comment.author || user.username === comment.author;

      if (!isAdmin && !isAuthor) {
        return reply.status(403).send(Errors.forbidden());
      }

      // Check if this comment has replies
      const [reply_] = await fastify.db
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(eq(comments.parent_id, commentId), isNull(comments.deleted_at))
        )
        .limit(1);

      if (reply_) {
        // Tombstone: keep body as [deleted] but mark deleted_at
        await fastify.db
          .update(comments)
          .set({ body: '[deleted]', deleted_at: new Date() })
          .where(eq(comments.id, commentId));
      } else {
        // Hard soft-delete
        await fastify.db
          .update(comments)
          .set({ deleted_at: new Date(), body: '' })
          .where(eq(comments.id, commentId));
      }

      return reply.status(204).send();
    }
  );

  // POST /api/v1/documents/:docId/comments/:commentId/ack
  fastify.post<{
    Params: { docId: string; commentId: string };
    Querystring: { agent_id?: string };
  }>(
    '/documents/:docId/comments/:commentId/ack',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { docId, commentId } = request.params;
      // Only admins may ack on behalf of another agent; everyone else acks as
      // themselves regardless of the query param.
      const isAdmin = request.user?.scopes?.includes('admin') ?? false;
      const callerId =
        request.user?.agentId ?? request.user?.username ?? 'unknown';
      const agentId =
        isAdmin && request.query.agent_id ? request.query.agent_id : callerId;

      // Verify comment exists
      const [comment] = await fastify.db
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(
            eq(comments.id, commentId),
            eq(comments.doc_id, docId),
            isNull(comments.deleted_at)
          )
        )
        .limit(1);

      if (!comment) {
        return reply.status(404).send(Errors.notFound('Comment'));
      }

      // Upsert read record
      await fastify.db.execute(
        sql`INSERT INTO comment_reads (comment_id, agent_id, read_at)
            VALUES (${commentId}, ${agentId}, now())
            ON CONFLICT (comment_id, agent_id) DO UPDATE SET read_at = now()`
      );

      return reply.status(204).send();
    }
  );
}
