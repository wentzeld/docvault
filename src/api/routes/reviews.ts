import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { documents, reviews, comments, agents } from '../../db/schema.js';
import { requireAuth, requireWrite } from '../middleware/requireAuth.js';
import { Errors } from '../lib/errors.js';
import { dispatchWebhook, dispatchWebhookToUrl, validateWebhookUrl } from '../lib/webhook.js';

const CreateReviewSchema = z.object({
  reviewers: z.array(z.string().min(1)).min(1),
  round: z.number().int().min(1).default(1),
  deadline: z.string().optional(),
  notify_on_complete: z.string().optional(),
  instructions: z.string().optional(),
});

const UpdateReviewSchema = z.object({
  status: z.enum(['in_progress', 'complete', 'skipped']),
});

function buildReviewItem(review: typeof reviews.$inferSelect) {
  const item: Record<string, unknown> = {
    reviewer: review.reviewer,
    status: review.status,
    assigned_at: review.assigned_at.toISOString(),
  };
  if (review.completed_at) {
    item['completed_at'] = review.completed_at.toISOString();
  }
  if (review.started_at) {
    item['started_at'] = review.started_at.toISOString();
  }
  if (review.instructions != null) {
    item['instructions'] = review.instructions;
  }
  return item;
}

export async function reviewRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/documents/:docId/reviews
  fastify.post<{ Params: { docId: string } }>(
    '/documents/:docId/reviews',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { docId } = request.params;
      const body = CreateReviewSchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const [doc] = await fastify.db
        .select()
        .from(documents)
        .where(and(eq(documents.id, docId), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) {
        return reply.status(404).send(Errors.notFound('Document'));
      }

      // Validate notify_on_complete URL if it looks like a direct HTTP URL
      if (body.data.notify_on_complete?.startsWith('http')) {
        const urlCheck = validateWebhookUrl(body.data.notify_on_complete);
        if (!urlCheck.valid) {
          return reply.status(400).send({
            status: 400,
            error: 'invalid_webhook_url',
            detail: urlCheck.reason,
          });
        }
      }

      // Check for active review round
      const existingReviews = await fastify.db
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.doc_id, docId),
            eq(reviews.round, body.data.round),
            sql`${reviews.status} NOT IN ('complete', 'skipped')`
          )
        );

      if (existingReviews.length > 0) {
        return reply.status(409).send({
          status: 409,
          error: 'conflict',
          detail: `Active review round ${body.data.round} already exists for this document`,
        });
      }

      const deadline = body.data.deadline ? new Date(body.data.deadline) : null;

      // Insert review rows for each reviewer
      const insertedReviews = await fastify.db
        .insert(reviews)
        .values(
          body.data.reviewers.map((reviewer) => ({
            doc_id: docId,
            reviewer,
            status: 'pending' as const,
            round: body.data.round,
            deadline,
            instructions: body.data.instructions ?? null,
            notify_agent: body.data.notify_on_complete ?? null,
          }))
        )
        .returning();

      // Update document workflow_status to in_review
      await fastify.db
        .update(documents)
        .set({ workflow_status: 'in_review', updated_at: new Date() })
        .where(eq(documents.id, docId));

      return reply.status(201).send({
        doc: docId,
        round: body.data.round,
        reviewers: insertedReviews.map(buildReviewItem),
        ...(deadline ? { deadline: deadline.toISOString() } : {}),
        ...(body.data.notify_on_complete
          ? { notify_on_complete: body.data.notify_on_complete }
          : {}),
      });
    }
  );

  // GET /api/v1/documents/:docId/reviews
  fastify.get<{
    Params: { docId: string };
    Querystring: { round?: string };
  }>(
    '/documents/:docId/reviews',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { docId } = request.params;
      const roundFilter = request.query.round
        ? parseInt(request.query.round, 10)
        : null;

      const [doc] = await fastify.db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.id, docId), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) {
        return reply.status(404).send(Errors.notFound('Document'));
      }

      const conditions = [eq(reviews.doc_id, docId)];
      if (roundFilter !== null) {
        conditions.push(eq(reviews.round, roundFilter));
      }

      const rows = await fastify.db
        .select()
        .from(reviews)
        .where(and(...conditions))
        .orderBy(reviews.round, reviews.assigned_at);

      if (rows.length === 0) {
        return reply.send({
          doc: docId,
          round: roundFilter ?? 1,
          reviewers: [],
          all_done: true,
        });
      }

      const round = rows[0]!.round;
      const allDone = rows.every(
        (r) => r.status === 'complete' || r.status === 'skipped'
      );

      const deadline = rows[0]?.deadline;
      const notifyAgent = rows[0]?.notify_agent;

      return reply.send({
        doc: docId,
        round,
        reviewers: rows.map(buildReviewItem),
        all_done: allDone,
        ...(deadline ? { deadline: deadline.toISOString() } : {}),
        ...(notifyAgent ? { notify_on_complete: notifyAgent } : {}),
      });
    }
  );

  // PATCH /api/v1/documents/:docId/reviews/:reviewer
  fastify.patch<{ Params: { docId: string; reviewer: string } }>(
    '/documents/:docId/reviews/:reviewer',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { docId, reviewer } = request.params;
      const body = UpdateReviewSchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const user = request.user!;
      const isAdmin = user.scopes?.includes('admin');
      const isReviewer = user.agentId === reviewer || user.username === reviewer;

      if (!isAdmin && !isReviewer) {
        return reply.status(403).send(
          Errors.forbidden('Only the assigned reviewer or admin can update review status')
        );
      }

      // Get the latest round review for this reviewer
      const existingRows = await fastify.db
        .select()
        .from(reviews)
        .where(and(eq(reviews.doc_id, docId), eq(reviews.reviewer, reviewer)))
        .orderBy(sql`round DESC`)
        .limit(1);

      const existing = existingRows[0];
      if (!existing) {
        return reply.status(404).send(Errors.notFound('Review assignment'));
      }

      const updates: Partial<typeof reviews.$inferInsert> = {
        status: body.data.status,
        updated_at: new Date(),
      };

      if (body.data.status === 'in_progress' && !existing.started_at) {
        updates.started_at = new Date();
      }
      if (body.data.status === 'complete' || body.data.status === 'skipped') {
        updates.completed_at = new Date();
      }

      await fastify.db
        .update(reviews)
        .set(updates)
        .where(eq(reviews.id, existing.id));

      // Check if all reviewers in this round are done
      const allReviews = await fastify.db
        .select()
        .from(reviews)
        .where(and(eq(reviews.doc_id, docId), eq(reviews.round, existing.round)));

      const updatedAll = allReviews.map((r) =>
        r.id === existing.id ? { ...r, ...updates } : r
      );

      const allDone = updatedAll.every(
        (r) => r.status === 'complete' || r.status === 'skipped'
      );

      if (allDone) {
        // Transition document to synthesizing
        await fastify.db
          .update(documents)
          .set({ workflow_status: 'synthesizing', updated_at: new Date() })
          .where(eq(documents.id, docId));

        // Count comments by reviewer agents
        const commentCounts = await fastify.db.execute(
          sql`SELECT COUNT(*) as count FROM comments WHERE doc_id = ${docId} AND deleted_at IS NULL`
        );
        const countRows = commentCounts.rows as Array<{ count: string }>;
        const totalComments = parseInt(countRows[0]?.count ?? '0', 10);

        const notifyTarget = existing.notify_agent;
        if (notifyTarget) {
          const payload = {
            event: 'review.complete',
            document_id: docId,
            review_summary: {
              total: updatedAll.length,
              complete: updatedAll.filter((r) => r.status === 'complete').length,
              comment_count: totalComments,
            },
            ts: new Date().toISOString(),
          };

          // Check if notifyTarget is an agent ID with webhook
          const agentRows = await fastify.db
            .select()
            .from(agents)
            .where(eq(agents.id, notifyTarget))
            .limit(1);

          const targetAgent = agentRows[0];
          if (targetAgent?.webhook_url) {
            dispatchWebhook(targetAgent, payload).catch((err) =>
              fastify.log.warn({ err }, 'review.complete webhook failed')
            );
          } else if (notifyTarget.startsWith('http')) {
            // Direct URL
            dispatchWebhookToUrl(notifyTarget, payload).catch((err) =>
              fastify.log.warn({ err }, 'review.complete direct webhook failed')
            );
          }
        }
      }

      // Return updated review list
      const allReviewsUpdated = await fastify.db
        .select()
        .from(reviews)
        .where(and(eq(reviews.doc_id, docId), eq(reviews.round, existing.round)));

      const allDoneFinal = allReviewsUpdated.every(
        (r) => r.status === 'complete' || r.status === 'skipped'
      );

      return reply.send({
        doc: docId,
        round: existing.round,
        reviewers: allReviewsUpdated.map(buildReviewItem),
        all_done: allDoneFinal,
      });
    }
  );
}
