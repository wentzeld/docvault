import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const docTypeEnum = pgEnum('doc_type', [
  'prd',
  'research',
  'design',
  'architecture',
  'notes',
]);

export const workflowStatusEnum = pgEnum('workflow_status', [
  'draft',
  'in_review',
  'synthesizing',
  'final',
]);

export const embedStatusEnum = pgEnum('embed_status', [
  'pending',
  'ready',
  'failed',
]);

export const commentTypeEnum = pgEnum('comment_type', ['inline', 'page']);

export const reviewStatusEnum = pgEnum('review_status', [
  'pending',
  'in_progress',
  'complete',
  'skipped',
]);

// ── documents ─────────────────────────────────────────────────────────────────

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    type: docTypeEnum('type').notNull(),
    project: text('project').notNull(),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    agent_id: text('agent_id'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    version: integer('version').notNull().default(1),
    words: integer('words').notNull().default(0),
    workflow_status: workflowStatusEnum('workflow_status')
      .notNull()
      .default('draft'),
    embed_status: embedStatusEnum('embed_status').notNull().default('pending'),
    embed_model: text('embed_model'),
    // embedding column is a vector(768) — managed via raw SQL migration
    // Drizzle does not have native vector type support so we store as text placeholder
    // and the actual column type is altered via migration SQL
    tsvector_col: text('tsvector_col'),
    commented_at: timestamp('commented_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    projectIdx: index('idx_documents_project').on(t.project),
    typeIdx: index('idx_documents_type').on(t.type),
    tagsIdx: index('idx_documents_tags').using('gin', t.tags),
    embedStatusIdx: index('idx_documents_embed_status').on(t.embed_status),
    deletedAtIdx: index('idx_documents_deleted_at').on(t.deleted_at),
    createdAtIdx: index('idx_documents_created_at').on(t.created_at),
    projectTypeIdx: index('idx_documents_project_type').on(
      t.project,
      t.type
    ),
    workflowIdx: index('idx_documents_workflow_status').on(t.workflow_status),
  })
);

// ── comments ──────────────────────────────────────────────────────────────────

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doc_id: uuid('doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    parent_id: uuid('parent_id'),
    author: text('author').notNull(),
    type: commentTypeEnum('type').notNull().default('page'),
    body: text('body').notNull(),
    selector: jsonb('selector'),
    round: integer('round').notNull().default(1),
    resolved: boolean('resolved').notNull().default(false),
    anchor_lost: boolean('anchor_lost').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    docIdx: index('idx_comments_doc_id').on(t.doc_id),
    parentIdx: index('idx_comments_parent_id').on(t.parent_id),
    authorIdx: index('idx_comments_author').on(t.author),
    roundIdx: index('idx_comments_doc_round').on(t.doc_id, t.round),
    resolvedIdx: index('idx_comments_resolved').on(t.doc_id, t.resolved),
    selfRef: foreignKey({ columns: [t.parent_id], foreignColumns: [t.id] }),
  })
);

// ── comment_reads (for agent unread tracking) ─────────────────────────────────

export const commentReads = pgTable(
  'comment_reads',
  {
    comment_id: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    agent_id: text('agent_id').notNull(),
    read_at: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: uniqueIndex('idx_comment_reads_pk').on(t.comment_id, t.agent_id),
    agentIdx: index('idx_comment_reads_agent').on(t.agent_id),
  })
);

// ── reviews ───────────────────────────────────────────────────────────────────

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doc_id: uuid('doc_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    reviewer: text('reviewer').notNull(),
    status: reviewStatusEnum('status').notNull().default('pending'),
    round: integer('round').notNull().default(1),
    instructions: text('instructions'),
    deadline: timestamp('deadline', { withTimezone: true }),
    notify_agent: text('notify_agent'),
    notify_url: text('notify_url'),
    assigned_at: timestamp('assigned_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    docReviewerRound: uniqueIndex('idx_reviews_doc_reviewer_round').on(
      t.doc_id,
      t.reviewer,
      t.round
    ),
    docStatusIdx: index('idx_reviews_doc_status').on(t.doc_id, t.status),
    deadlineIdx: index('idx_reviews_deadline').on(t.deadline),
  })
);

// ── document_versions (immutable content snapshots) ──────────────────────────

export const documentVersions = pgTable(
  'document_versions',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    doc_id:     uuid('doc_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    version:    integer('version').notNull(),
    title:      text('title').notNull(),
    content:    text('content').notNull(),
    words:      integer('words').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    author:     text('author'),
  },
  (t) => ({
    docVersionIdx: index('idx_document_versions_doc_version').on(t.doc_id, t.version),
  })
);

// ── sessions ──────────────────────────────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ip: text('ip'),
    user_agent: text('user_agent'),
  },
  (t) => ({
    usernameIdx: index('idx_sessions_username').on(t.username),
    expiresIdx: index('idx_sessions_expires_at').on(t.expires_at),
  })
);

// ── tokens (API bearer tokens for agents) ─────────────────────────────────────

export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    hash: text('hash').notNull(),
    lookup_hash: text('lookup_hash').notNull().unique(),
    agent_id: text('agent_id').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{read,write}'::text[]`),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked: boolean('revoked').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    agentIdx: index('idx_tokens_agent_id').on(t.agent_id),
    revokedIdx: index('idx_tokens_revoked').on(t.revoked),
  })
);

// ── agents (webhook registrations) ───────────────────────────────────────────

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  webhook_url: text('webhook_url'),
  webhook_secret_enc: text('webhook_secret_enc'),
  webhook_events: text('webhook_events')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  active: boolean('active').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ── users (local password auth for browser) ───────────────────────────────────

export const users = pgTable('users', {
  username: text('username').primaryKey(),
  password_hash: text('password_hash').notNull(),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Type exports
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Token = typeof tokens.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type User = typeof users.$inferSelect;
export type CommentRead = typeof commentReads.$inferSelect;
export type DocumentVersion    = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;
