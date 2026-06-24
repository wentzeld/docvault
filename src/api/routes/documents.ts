import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, isNull, sql, inArray, lte, gte, desc } from 'drizzle-orm';
import { documents, comments, documentVersions } from '../../db/schema.js';
import { requireAuth, requireWrite } from '../middleware/requireAuth.js';
import { renderMarkdown, countWords, invalidateCache } from '../lib/markdown.js';
import { Errors } from '../lib/errors.js';

const DocTypeValues = ['prd', 'research', 'design', 'architecture', 'notes'] as const;
const WorkflowStatusValues = ['draft', 'in_review', 'synthesizing', 'final'] as const;

const CreateDocSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  type: z.enum(DocTypeValues),
  project: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  agent_id: z.string().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

const UpdateDocSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  type: z.enum(DocTypeValues).optional(),
  project: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
  workflow_status: z.enum(WorkflowStatusValues).optional(),
  version: z.number().int().positive().optional(),
});

const ListQuerySchema = z.object({
  project: z.string().optional(),
  type: z.enum(DocTypeValues).optional(),
  tags: z.string().optional(),
  workflow_status: z.enum(WorkflowStatusValues).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  commented_after: z.string().optional(),
  sort: z.enum(['created', 'updated', 'commented']).default('created'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  content: z.coerce.boolean().default(false),
  nulls: z.coerce.boolean().default(false),
});

function buildDocResponse(
  doc: typeof documents.$inferSelect,
  opts: {
    includeContent?: boolean;
    includeHtml?: string;
    includeNulls?: boolean;
    commentCount?: number;
  }
) {
  const base: Record<string, unknown> = {
    id: doc.id,
    title: doc.title,
    type: doc.type,
    project: doc.project,
    tags: doc.tags,
    version: doc.version,
    words: doc.words,
    status: doc.workflow_status,
    indexed: doc.embed_status === 'ready',
    created: doc.created_at.toISOString(),
    updated: doc.updated_at.toISOString(),
    commented: doc.commented_at ? doc.commented_at.toISOString() : null,
  };

  if (opts.includeContent) {
    base['content'] = doc.content;
  }
  if (opts.includeHtml) {
    base['html'] = opts.includeHtml;
  }
  if (opts.commentCount !== undefined) {
    base['comments'] = opts.commentCount;
  }

  // Conditionally include null/false fields
  if (opts.includeNulls) {
    base['agent_id'] = doc.agent_id ?? null;
    base['commented_at'] = doc.commented_at?.toISOString() ?? null;
    base['deleted_at'] = doc.deleted_at?.toISOString() ?? null;
    base['embed_status'] = doc.embed_status;
    base['embed_model'] = doc.embed_model ?? null;
    base['metadata'] = doc.metadata;
  } else {
    if (doc.agent_id) base['agent_id'] = doc.agent_id;
    if (doc.commented_at) base['commented_at'] = doc.commented_at.toISOString();
    if (doc.embed_model) base['embed_model'] = doc.embed_model;
    if (doc.metadata && Object.keys(doc.metadata as object).length > 0) {
      base['metadata'] = doc.metadata;
    }
  }

  return base;
}

export async function documentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/documents
  fastify.post(
    '/documents',
    { preHandler: requireWrite },
    async (request, reply) => {
      const body = CreateDocSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(
          Errors.validationError(body.error.message)
        );
      }

      const data = body.data;
      const agentId = request.user?.scopes?.includes('admin')
        ? (data.agent_id ?? request.user?.agentId ?? null)
        : (request.user?.agentId ?? null);

      const words = countWords(data.content);

      const [doc] = await fastify.db
        .insert(documents)
        .values({
          title: data.title,
          content: data.content,
          type: data.type,
          project: data.project,
          tags: data.tags,
          agent_id: agentId,
          metadata: data.metadata,
          words,
          version: 1,
          workflow_status: 'draft',
          embed_status: 'pending',
        })
        .returning();

      if (!doc) {
        return reply.status(500).send(Errors.internalError());
      }

      // Enqueue embedding job
      try {
        await fastify.boss.send('embed-document', { docId: doc.id }, {
          expireInSeconds: 120,
        });
      } catch (err) {
        fastify.log.error({ err }, 'Failed to enqueue embed job');
      }

      return reply.status(201).send(buildDocResponse(doc, { includeContent: false }));
    }
  );

  // GET /api/v1/documents
  fastify.get(
    '/documents',
    { preHandler: requireAuth },
    async (request, reply) => {
      const query = ListQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send(Errors.validationError(query.error.message));
      }

      const q = query.data;

      // Build filters
      const conditions = [isNull(documents.deleted_at)];

      if (q.type) conditions.push(eq(documents.type, q.type));
      if (q.project) conditions.push(eq(documents.project, q.project));
      if (q.workflow_status) {
        conditions.push(eq(documents.workflow_status, q.workflow_status));
      }

      if (q.tags) {
        const tagList = q.tags.split(',').map((t) => t.trim());
        conditions.push(sql`${documents.tags} @> ${tagList}::text[]`);
      }

      if (q.after) {
        conditions.push(gte(documents.created_at, new Date(q.after)));
      }
      if (q.before) {
        conditions.push(lte(documents.created_at, new Date(q.before)));
      }
      if (q.commented_after) {
        conditions.push(
          gte(
            documents.commented_at,
            new Date(q.commented_after)
          )
        );
      }

      // Sort column: commented_at is nullable → COALESCE to epoch so
      // never-commented docs sort last on desc (and first on asc).
      const sortExpr =
        q.sort === 'updated' ? sql`${documents.updated_at}`
        : q.sort === 'commented' ? sql`COALESCE(${documents.commented_at}, to_timestamp(0))`
        : sql`${documents.created_at}`;

      // Cursor pagination keyed to the active (sort, order): decode base64
      // cursor to get the sort value + id. A cursor minted under a different
      // sort/order is ignored rather than producing a wrong page.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (q.cursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(q.cursor, 'base64').toString('utf-8')
          ) as { v?: string; created_at?: string; id: string; sort?: string; order?: string };
          const cursorVal = decoded.v ?? decoded.created_at; // legacy cursors carry created_at
          const cursorSort = decoded.sort ?? 'created';
          const cursorOrder = decoded.order ?? 'desc';
          if (
            cursorVal && UUID_RE.test(decoded.id) &&
            cursorSort === q.sort && cursorOrder === q.order &&
            !isNaN(new Date(cursorVal).getTime())
          ) {
            conditions.push(
              q.order === 'desc'
                ? sql`(${sortExpr}, ${documents.id}) < (${new Date(cursorVal)}::timestamptz, ${decoded.id}::uuid)`
                : sql`(${sortExpr}, ${documents.id}) > (${new Date(cursorVal)}::timestamptz, ${decoded.id}::uuid)`
            );
          }
        } catch {
          // ignore bad cursor
        }
      }

      const limit = Math.min(q.limit, 100);
      const rows = await fastify.db
        .select()
        .from(documents)
        .where(and(...conditions))
        .orderBy(
          q.order === 'desc' ? sql`${sortExpr} DESC` : sql`${sortExpr} ASC`,
          q.order === 'desc' ? desc(documents.id) : documents.id
        )
        .limit(limit + 1); // fetch one extra to detect next page

      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit);
      const lastRow = data[data.length - 1];

      let nextCursor: string | undefined;
      if (hasMore && lastRow) {
        const lastVal =
          q.sort === 'updated' ? lastRow.updated_at
          : q.sort === 'commented' ? (lastRow.commented_at ?? new Date(0))
          : lastRow.created_at;
        nextCursor = Buffer.from(
          JSON.stringify({
            v: lastVal.toISOString(),
            id: lastRow.id,
            sort: q.sort,
            order: q.order,
          })
        ).toString('base64');
      }

      const result = data.map((doc) =>
        buildDocResponse(doc, {
          includeContent: q.content,
          includeNulls: q.nulls,
        })
      );

      return reply.send({
        data: result,
        ...(nextCursor ? { next: nextCursor } : {}),
      });
    }
  );

  // GET /api/v1/documents/:id
  fastify.get<{ Params: { id: string }; Querystring: { nulls?: string } }>(
    '/documents/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      const includeNulls = request.query.nulls === 'true';

      const [doc] = await fastify.db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) {
        return reply.status(404).send(Errors.notFound('Document'));
      }

      // Get comment count
      const commentCountResult = await fastify.db.execute(
        sql`SELECT COUNT(*) as count FROM comments WHERE doc_id = ${id} AND deleted_at IS NULL`
      );
      const countRows = commentCountResult.rows as Array<{ count: string }>;
      const commentCount = parseInt(countRows[0]?.count ?? '0', 10);

      // Render markdown
      const html = await renderMarkdown(doc.content, `${doc.id}:${doc.version}`);

      return reply.send(
        buildDocResponse(doc, {
          includeContent: true,
          includeHtml: html,
          includeNulls,
          commentCount,
        })
      );
    }
  );

  // PUT /api/v1/documents/:id
  fastify.put<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { id } = request.params;
      const body = UpdateDocSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      // Atomic optimistic update. Locking the row with SELECT ... FOR UPDATE
      // serializes concurrent PUTs on the same document, so two writers cannot
      // both pass the version check and clobber each other (lost update). The
      // version check, snapshot, and bump all happen inside one transaction.
      const txResult = await fastify.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(documents)
          .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
          .for('update')
          .limit(1);

        if (!existing) return { kind: 'not_found' as const };

        if (
          body.data.version !== undefined &&
          body.data.version !== existing.version
        ) {
          return { kind: 'conflict' as const, current: existing.version };
        }

        // Snapshot the current version before overwriting
        await tx.insert(documentVersions).values({
          doc_id:     id,
          version:    existing.version,
          title:      existing.title,
          content:    existing.content,
          words:      existing.words,
          created_at: existing.updated_at,
          author:     null,
        });

        const updates: Partial<typeof documents.$inferInsert> = {
          updated_at: new Date(),
          version: existing.version + 1,
        };

        if (body.data.title !== undefined) updates.title = body.data.title;
        if (body.data.content !== undefined) {
          updates.content = body.data.content;
          updates.words = countWords(body.data.content);
          updates.embed_status = 'pending';
        }
        if (body.data.type !== undefined) updates.type = body.data.type;
        if (body.data.project !== undefined) updates.project = body.data.project;
        if (body.data.tags !== undefined) updates.tags = body.data.tags;
        if (body.data.metadata !== undefined) updates.metadata = body.data.metadata;
        if (body.data.workflow_status !== undefined) {
          updates.workflow_status = body.data.workflow_status;
        }

        const [row] = await tx
          .update(documents)
          .set(updates)
          .where(eq(documents.id, id))
          .returning();

        return { kind: 'ok' as const, updated: row, prevVersion: existing.version };
      });

      if (txResult.kind === 'not_found') {
        return reply.status(404).send(Errors.notFound('Document'));
      }
      if (txResult.kind === 'conflict') {
        return reply.status(409).send({
          status: 409,
          error: 'version_conflict',
          detail: `Expected version ${txResult.current}, got ${body.data.version}`,
        });
      }

      const updated = txResult.updated;
      if (!updated) {
        return reply.status(500).send(Errors.internalError());
      }

      // Invalidate markdown cache
      invalidateCache(`${id}:${txResult.prevVersion}`);

      // Mark anchor_lost for inline comments whose exact text is gone
      if (body.data.content !== undefined) {
        const newContent = body.data.content;
        // Find inline comments and check if quote text still exists
        const inlineComments = await fastify.db
          .select()
          .from(comments)
          .where(
            and(
              eq(comments.doc_id, id),
              eq(comments.type, 'inline'),
              isNull(comments.deleted_at),
              sql`${comments.selector} IS NOT NULL`
            )
          );

        for (const comment of inlineComments) {
          const selector = comment.selector as {
            quote?: { exact?: string };
            pos?: { end?: number };
          } | null;
          const exact = selector?.quote?.exact;
          const posEnd = selector?.pos?.end;

          const shouldMarkLost =
            (exact && !newContent.includes(exact)) ||
            (posEnd !== undefined && posEnd > newContent.length);

          if (shouldMarkLost && !comment.anchor_lost) {
            await fastify.db
              .update(comments)
              .set({ anchor_lost: true })
              .where(eq(comments.id, comment.id));
          }
        }

        // Re-enqueue embedding
        try {
          await fastify.boss.send('embed-document', { docId: id }, {
            expireInSeconds: 120,
          });
        } catch (err) {
          fastify.log.error({ err }, 'Failed to enqueue embed job');
        }
      }

      const html = await renderMarkdown(
        updated.content,
        `${updated.id}:${updated.version}`
      );

      return reply.send(
        buildDocResponse(updated, {
          includeContent: true,
          includeHtml: html,
        })
      );
    }
  );

  // GET /api/v1/documents/:id/versions
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/versions',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;

      const [doc] = await fastify.db
        .select({ id: documents.id, version: documents.version, title: documents.title, words: documents.words, updated_at: documents.updated_at })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) return reply.status(404).send(Errors.notFound('Document'));

      const snapshots = await fastify.db
        .select({ version: documentVersions.version, title: documentVersions.title, words: documentVersions.words, created_at: documentVersions.created_at, author: documentVersions.author })
        .from(documentVersions)
        .where(eq(documentVersions.doc_id, id))
        .orderBy(desc(documentVersions.version));

      const current = { version: doc.version, title: doc.title, words: doc.words, created_at: doc.updated_at.toISOString(), author: null, current: true };
      const history = snapshots.map(s => ({ version: s.version, title: s.title, words: s.words, created_at: s.created_at.toISOString(), author: s.author ?? null, current: false }));

      return reply.send({ data: [current, ...history] });
    }
  );

  // GET /api/v1/documents/:id/versions/:version
  fastify.get<{ Params: { id: string; version: string } }>(
    '/documents/:id/versions/:version',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, version: versionStr } = request.params;
      const versionNum = parseInt(versionStr, 10);

      if (isNaN(versionNum) || versionNum < 1) {
        return reply.status(400).send(Errors.validationError('Invalid version number'));
      }

      const [doc] = await fastify.db
        .select({ id: documents.id, version: documents.version })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) return reply.status(404).send(Errors.notFound('Document'));

      if (versionNum === doc.version) {
        return reply.status(302).redirect(`/api/v1/documents/${id}`);
      }

      const [snap] = await fastify.db
        .select()
        .from(documentVersions)
        .where(and(eq(documentVersions.doc_id, id), eq(documentVersions.version, versionNum)))
        .limit(1);

      if (!snap) return reply.status(404).send(Errors.notFound('Version'));

      const html = await renderMarkdown(snap.content, `${id}:v${versionNum}:snap`);

      return reply.send({
        doc_id: snap.doc_id, version: snap.version, title: snap.title,
        content: snap.content, words: snap.words,
        created_at: snap.created_at.toISOString(), author: snap.author ?? null,
        html,
      });
    }
  );

  // DELETE /api/v1/documents/:id
  fastify.delete<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { id } = request.params;

      const [existingDoc] = await fastify.db
        .select({ id: documents.id, version: documents.version })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
        .limit(1);

      if (!existingDoc) {
        return reply.status(404).send(Errors.notFound('Document'));
      }

      await fastify.db
        .update(documents)
        .set({ deleted_at: new Date() })
        .where(eq(documents.id, id));

      invalidateCache(`${id}:${existingDoc.version}`);

      return reply.status(204).send();
    }
  );

  // PATCH /api/v1/documents/:id — workflow_status only
  fastify.patch<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { id } = request.params;
      const body = z
        .object({ workflow_status: z.enum(WorkflowStatusValues) })
        .safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const [existing] = await fastify.db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
        .limit(1);

      if (!existing) {
        return reply.status(404).send(Errors.notFound('Document'));
      }

      const [updated] = await fastify.db
        .update(documents)
        .set({
          workflow_status: body.data.workflow_status,
          updated_at: new Date(),
        })
        .where(eq(documents.id, id))
        .returning();

      return reply.send(buildDocResponse(updated!, {}));
    }
  );

  // POST /api/v1/documents/:id/approve
  // Reviewer-initiated approval or change request — bypasses full review workflow.
  const ApproveSchema = z.object({
    verdict: z.enum(['approved', 'changes_requested']),
    comment: z.string().max(2000).optional(),
  });

  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/approve',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { id } = request.params;
      const body = ApproveSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const [doc] = await fastify.db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) return reply.status(404).send(Errors.notFound('Document'));

      const reviewer = request.user!.username ?? request.user!.agentId ?? 'admin';
      const newStatus = body.data.verdict === 'approved' ? 'final' : 'draft';

      await fastify.db
        .update(documents)
        .set({ workflow_status: newStatus as typeof WorkflowStatusValues[number], updated_at: new Date() })
        .where(eq(documents.id, id));

      if (body.data.verdict === 'approved') {
        const commentBody = body.data.comment
          ? `**[review:approved]** Approved by ${reviewer}\n${body.data.comment}`
          : `**[review:approved]** Approved by ${reviewer}`;
        await fastify.db.insert(comments).values({
          doc_id: id, author: reviewer, type: 'page' as const, body: commentBody, round: 1,
        });
      } else {
        const commentBody = body.data.comment
          ? `**[review:changes_requested]** Changes requested by ${reviewer}\n${body.data.comment}`
          : `**[review:changes_requested]** Changes requested by ${reviewer}`;
        await fastify.db.insert(comments).values({
          doc_id: id, author: reviewer, type: 'page' as const, body: commentBody, round: 1,
        });
      }

      // Enqueue notification to the creating agent
      if (doc.agent_id) {
        const publicUrl = process.env.DOCVAULT_PUBLIC_URL || `http://${process.env.DOCVAULT_SERVER_HOST || '127.0.0.1'}:${process.env.DOCVAULT_SERVER_PORT || '3000'}`;
        await fastify.boss.send('notify-webhook', {
          agentId: doc.agent_id,
          event: body.data.verdict,
          docId: id,
          docTitle: doc.title,
          docType: doc.type,
          docProject: doc.project,
          reviewer,
          comment: body.data.comment ?? null,
          docUrl: `${publicUrl}/ui/docs/${id}`,
        }).catch((err: Error) => fastify.log.warn({ err }, 'Failed to enqueue notify-webhook'));
      }

      return reply.send({ id, verdict: body.data.verdict, status: newStatus });
    }
  );

  // POST /api/v1/documents/:id/resend-notification
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/resend-notification',
    { preHandler: requireWrite },
    async (request, reply) => {
      const { id } = request.params;

      const [doc] = await fastify.db
        .select()
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deleted_at)))
        .limit(1);

      if (!doc) return reply.status(404).send(Errors.notFound('Document'));

      // Authorization: admin can resend on any doc; agents can only resend on their own docs
      const isAdmin = request.user?.scopes?.includes('admin') ?? false;
      const callerAgentId = request.user?.agentId ?? null;
      if (!isAdmin && doc.agent_id !== callerAgentId) {
        // Return generic 404 to avoid leaking existence to unauthorized callers
        return reply.status(404).send(Errors.notFound('Document'));
      }

      if (!doc.agent_id) {
        return reply.status(422).send({
          status: 422,
          error: 'no_agent',
          detail: 'Document has no agent_id — cannot resend notification',
        });
      }

      // Find most recent changes_requested comment
      const [changesComment] = await fastify.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.doc_id, id),
            isNull(comments.deleted_at),
            sql`${comments.body} LIKE '%[review:changes_requested]%'`
          )
        )
        .orderBy(desc(comments.created_at))
        .limit(1);

      if (!changesComment) {
        return reply.status(404).send({
          status: 404,
          error: 'no_changes_requested',
          detail: 'No changes_requested review event found on this document',
        });
      }

      // Check for a [status:processing] comment posted after that change-request AND within last 3 minutes
      const [processingComment] = await fastify.db
        .select()
        .from(comments)
        .where(
          and(
            eq(comments.doc_id, id),
            isNull(comments.deleted_at),
            sql`${comments.body} LIKE '%[status:processing]%'`,
            sql`${comments.created_at} > ${changesComment.created_at}`,
            sql`${comments.created_at} > NOW() - INTERVAL '3 minutes'`
          )
        )
        .orderBy(desc(comments.created_at))
        .limit(1);

      if (processingComment) {
        return reply.status(409).send({
          status: 409,
          error: 'bot_working',
          detail: 'Bot is currently processing this document — try again in a moment',
        });
      }

      // Re-enqueue the notify-webhook job
      const publicUrl = process.env.DOCVAULT_PUBLIC_URL || `http://${process.env.DOCVAULT_SERVER_HOST || '127.0.0.1'}:${process.env.DOCVAULT_SERVER_PORT || '3000'}`;

      // Extract reviewer and comment from the changes_requested comment body
      const crBody = changesComment.body;
      const reviewerMatch = crBody.match(/\*\*\[review:changes_requested\]\*\* Changes requested by ([^\n]+)/);
      const reviewer = reviewerMatch?.[1]?.trim() ?? changesComment.author;
      const commentText = crBody.includes('\n') ? crBody.slice(crBody.indexOf('\n') + 1).trim() : undefined;

      await fastify.boss.send('notify-webhook', {
        agentId: doc.agent_id,
        event: 'changes_requested',
        docId: id,
        docTitle: doc.title,
        docType: doc.type,
        docProject: doc.project,
        reviewer,
        comment: commentText ?? null,
        docUrl: `${publicUrl}/ui/docs/${id}`,
      });

      return reply.send({ id, queued: true });
    }
  );
}
