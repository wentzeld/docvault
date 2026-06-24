# DocVault Technical Architecture

## Table of Contents

1. System Overview
2. Directory Structure
3. Database Schema
4. API Route Map
5. Embedding Worker Design
6. Web UI Architecture
7. Authentication Flow
8. Configuration
9. Systemd Service Definitions
10. Caddy Configuration
11. Install Script Outline
12. Key Design Decisions

---

## 1. System Overview

```
                        ┌─────────────────────────────────────────────┐
                        │           Tailscale Network (100.x/8)        │
                        │                                               │
                        │  Browser / Agent CLI                          │
                        │       │                                       │
                        │       ▼                                       │
                        │  ┌─────────┐   TLS termination                │
                        │  │  Caddy  │   CIDR: 100.64.0.0/10           │
                        │  │  :443   │   + 100.0.0.0/8                  │
                        │  └────┬────┘                                  │
                        │       │ HTTP/1.1 proxy_pass                   │
                        │       ▼                                       │
                        │  ┌──────────────────────────────────────┐    │
                        │  │        Fastify v5 API                 │    │
                        │  │        127.0.0.1:3000                 │    │
                        │  │                                       │    │
                        │  │  ┌──────────┐  ┌────────────────┐   │    │
                        │  │  │  Routes  │  │   Plugins      │   │    │
                        │  │  │ /api/v1/ │  │ auth, cors,    │   │    │
                        │  │  │ docs     │  │ rate-limit,    │   │    │
                        │  │  │ comments │  │ multipart      │   │    │
                        │  │  │ search   │  └────────────────┘   │    │
                        │  │  │ reviews  │                        │    │
                        │  │  │ webhooks │  ┌────────────────┐   │    │
                        │  │  │ tokens   │  │  Static UI     │   │    │
                        │  │  │ health   │  │  /ui (React)   │   │    │
                        │  │  └──────────┘  └────────────────┘   │    │
                        │  └───────────────────────┬──────────────┘    │
                        │                          │                    │
                        │          ┌───────────────┼──────────┐        │
                        │          │               │          │        │
                        │          ▼               ▼          ▼        │
                        │  ┌──────────────┐  ┌─────────┐  ┌──────┐   │
                        │  │ PostgreSQL 16│  │pg-boss  │  │ CLI  │   │
                        │  │ :5432        │  │ queue   │  │docv  │   │
                        │  │              │  │(in PG)  │  │ault  │   │
                        │  │ documents    │  └────┬────┘  └──────┘   │
                        │  │ comments     │       │                    │
                        │  │ reviews      │       │ LISTEN/NOTIFY      │
                        │  │ sessions     │       ▼                    │
                        │  │ tokens       │  ┌────────────────────┐   │
                        │  │ agents       │  │  Python Worker     │   │
                        │  │ pgvector     │  │  GPU: RTX 3050     │   │
                        │  │  (HNSW)      │  │                    │   │
                        │  │ tsvector GIN │  │  nomic-embed-      │   │
                        │  └──────────────┘  │  text-v1.5         │   │
                        │                    │  batch_size=16     │   │
                        │                    │  sentence-snippets  │   │
                        │                    └────────────────────┘   │
                        │                                               │
                        │  systemd manages: docvault-api.service        │
                        │                   docvault-worker.service     │
                        └─────────────────────────────────────────────┘
```

**Data flow — document ingest:**
1. Agent/browser POSTs markdown → Fastify validates + stores in PostgreSQL
2. Fastify enqueues `embed-document` job via pg-boss (INSERT into pgboss schema)
3. Python worker polls pg-boss queue, pulls batch of up to 16 jobs
4. Worker calls sentence-transformers (GPU), writes 768-dim vector to `documents.embedding`
5. Worker updates `embed_status = 'ready'`, `embed_model = 'nomic-embed-text-v1.5'`

**Data flow — search:**
1. POST /api/v1/search arrives at Fastify
2. Fastify calls Python worker's local HTTP endpoint (127.0.0.1:8001) to embed query
3. Fastify executes RRF SQL: pgvector ANN + tsvector GIN, fused with RRF formula
4. Snippet generation: keyword mode = sentence containing match, semantic mode = sentence with highest cosine sim to query vector (worker HTTP)
5. Returns ranked results (no envelope, short field names)

---

## 2. Directory Structure

```
~/docvault/
├── package.json                  # Root: workspaces ["src/api", "src/ui"]
├── package-lock.json
├── tsconfig.json                 # Base TS config (paths, strict)
├── tsconfig.api.json             # Extends base, outDir=dist/api
├── drizzle.config.ts             # Drizzle Kit config (points to src/db/schema.ts)
├── .env.example                  # Canonical env var list (never committed with values)
├── .env                          # Gitignored — actual secrets
├── .gitignore
│
├── src/
│   ├── api/                      # Fastify application
│   │   ├── index.ts              # Entry point: build() factory + listen()
│   │   ├── app.ts                # Fastify instance creation, plugin registration order
│   │   ├── plugins/
│   │   │   ├── db.ts             # Drizzle + pg pool, fastify.decorate('db', ...)
│   │   │   ├── auth.ts           # Bearer token + session cookie verification hooks
│   │   │   ├── boss.ts           # pg-boss instance, fastify.decorate('boss', ...)
│   │   │   ├── worker-client.ts  # Axios client to Python worker :8001
│   │   │   └── rate-limit.ts     # @fastify/rate-limit config per-route overrides
│   │   ├── routes/
│   │   │   ├── health.ts         # GET /health
│   │   │   ├── documents.ts      # CRUD /api/v1/documents
│   │   │   ├── comments.ts       # CRUD /api/v1/documents/:id/comments
│   │   │   ├── search.ts         # POST /api/v1/search
│   │   │   ├── reviews.ts        # POST /api/v1/documents/:id/reviews + status
│   │   │   ├── webhooks.ts       # CRUD /api/v1/agents/:agentId/webhooks
│   │   │   ├── tokens.ts         # POST /api/v1/tokens (admin: create/revoke)
│   │   │   └── users.ts          # POST /api/v1/users/password (admin)
│   │   ├── middleware/
│   │   │   ├── require-auth.ts   # preHandler hook: validates bearer or cookie
│   │   │   ├── require-admin.ts  # preHandler hook: validates admin scope
│   │   │   └── soft-delete.ts    # addHook onSend: strip deleted_at records
│   │   ├── lib/
│   │   │   ├── rrf.ts            # RRF SQL builder (parameterised)
│   │   │   ├── snippet.ts        # Keyword snippet extraction (sentence split)
│   │   │   ├── webhook.ts        # HMAC signing, retry queue logic
│   │   │   ├── markdown.ts       # remark→rehype pipeline, block-id injection
│   │   │   └── errors.ts         # Typed error factory {status,error,detail}
│   │   └── types/
│   │       ├── fastify.d.ts      # Module augmentation: FastifyInstance decorators
│   │       └── models.ts         # Shared TypeScript types matching DB rows
│   │
│   ├── db/
│   │   ├── schema.ts             # All Drizzle table definitions (single source of truth)
│   │   ├── index.ts              # Pool creation, drizzle() export
│   │   └── migrations/           # Generated by drizzle-kit (timestamped .sql files)
│   │       └── meta/             # Drizzle migration metadata JSON
│   │
│   ├── jobs/
│   │   ├── definitions.ts        # Job name constants + TypeScript payload types
│   │   ├── embed-document.ts     # pg-boss job handler registration (API side)
│   │   └── notify-webhook.ts     # pg-boss job handler for webhook dispatch + retry
│   │
│   ├── cli/
│   │   ├── index.ts              # CLI entry: commander root command
│   │   ├── commands/
│   │   │   ├── token.ts          # docvault admin token create/revoke/list
│   │   │   └── user.ts           # docvault admin user set-password
│   │   └── lib/
│   │       └── db-connect.ts     # Standalone DB connection for CLI (no Fastify)
│   │
│   └── ui/                       # React SPA (built → dist/ui, served by Fastify)
│       ├── package.json          # UI-specific deps (react, annotator, etc.)
│       ├── vite.config.ts        # Vite build config
│       ├── index.html            # SPA shell
│       ├── src/
│       │   ├── main.tsx          # ReactDOM.createRoot
│       │   ├── App.tsx           # Router setup (React Router v7)
│       │   ├── api/
│       │   │   └── client.ts     # fetch wrapper: base URL, auth header, error parse
│       │   ├── components/
│       │   │   ├── Layout.tsx    # Shell: sidebar nav + main content area
│       │   │   ├── DocList.tsx   # Paginated document list with cursor pagination
│       │   │   ├── DocViewer.tsx # Markdown render + annotator mount point
│       │   │   ├── DocEditor.tsx # Textarea editor + preview toggle
│       │   │   ├── CommentPanel.tsx  # Sliding side panel: comment thread list
│       │   │   ├── CommentThread.tsx # Nested comment display + reply form
│       │   │   ├── SearchBox.tsx     # Hybrid search UI, filter chips
│       │   │   ├── ReviewBadge.tsx   # Workflow status chip
│       │   │   └── TokenManager.tsx  # Admin: list/create/revoke tokens
│       │   ├── hooks/
│       │   │   ├── useAnnotator.ts   # Mounts recogito/text-annotator-js, syncs DB
│       │   │   ├── useComments.ts    # SWR-based comment CRUD
│       │   │   ├── useDocs.ts        # SWR cursor-paginated doc list
│       │   │   └── useAuth.ts        # Session state, login/logout
│       │   ├── store/
│       │   │   └── ui.ts         # Zustand: dark mode, panel open state, active doc
│       │   └── styles/
│       │       ├── global.css    # CSS variables, dark mode via [data-theme=dark]
│       │       └── annotator.css # Override recogito highlight colors
│       └── dist/                 # Built by `vite build`, gitignored
│
├── worker/
│   ├── requirements.txt          # sentence-transformers, psycopg[binary], httpx
│   ├── main.py                   # Entry: asyncio event loop, pg-boss poll + HTTP server
│   ├── embedder.py               # Model load, batch inference, snippet generation
│   ├── job_handler.py            # pg-boss protocol: LISTEN, claim job, ack/fail
│   ├── snippet_server.py         # aiohttp server :8001 /embed and /snippet endpoints
│   └── config.py                 # Reads .env / env vars for DB URL, model path
│
├── config/
│   ├── docvault.yaml             # Application config (all tunables with defaults)
│   └── .env.example              # All DOCVAULT_* env vars documented
│
├── infra/
│   ├── Caddyfile                 # Production Caddy config
│   ├── docvault-api.service      # systemd unit for Fastify
│   └── docvault-worker.service   # systemd unit for Python worker
│
└── scripts/
    ├── install.sh                # Full install sequence (idempotent)
    └── backup.sh                 # pg_dump + rotate local backups
```

---

## 3. Database Schema

### 3.1 Drizzle ORM Schema (`src/db/schema.ts`)

```typescript
import {
  pgTable, pgEnum, uuid, text, integer, boolean, timestamp,
  jsonb, vector, index, uniqueIndex, foreignKey, serial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const docTypeEnum = pgEnum('doc_type', [
  'prd', 'research', 'design', 'architecture', 'notes',
]);

export const workflowStatusEnum = pgEnum('workflow_status', [
  'draft', 'in_review', 'synthesizing', 'final',
]);

export const embedStatusEnum = pgEnum('embed_status', [
  'pending', 'ready', 'failed',
]);

export const commentTypeEnum = pgEnum('comment_type', ['inline', 'page']);

export const reviewStatusEnum = pgEnum('review_status', [
  'pending', 'in_progress', 'complete', 'skipped',
]);

// ── documents ─────────────────────────────────────────────────────────────────

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    type: docTypeEnum('type').notNull(),
    project: text('project').notNull(),           // slug, e.g. "alpha-v2"
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    agent_id: text('agent_id'),                   // nullable: null = human author
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    version: integer('version').notNull().default(1),
    words: integer('words').notNull().default(0),
    workflow_status: workflowStatusEnum('workflow_status')
      .notNull().default('draft'),
    embed_status: embedStatusEnum('embed_status')
      .notNull().default('pending'),
    embed_model: text('embed_model'),             // null until embedded
    embedding: vector('embedding', { dimensions: 768 }), // null until embedded
    tsvector: text('tsvector'),                   // maintained by trigger (type tsvector in DB)
    commented_at: timestamp('commented_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }), // null = not deleted
  },
  (t) => ({
    // Indexes declared here are for Drizzle awareness; HNSW and GIN are raw SQL below
    projectIdx: index('idx_documents_project').on(t.project),
    typeIdx: index('idx_documents_type').on(t.type),
    tagsIdx: index('idx_documents_tags').using('gin', t.tags),
    embedStatusIdx: index('idx_documents_embed_status').on(t.embed_status),
    deletedAtIdx: index('idx_documents_deleted_at').on(t.deleted_at),
    createdAtIdx: index('idx_documents_created_at').on(t.created_at),
    projectTypeIdx: index('idx_documents_project_type').on(t.project, t.type),
    workflowIdx: index('idx_documents_workflow_status').on(t.workflow_status),
  }),
);

// ── comments ──────────────────────────────────────────────────────────────────

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doc_id: uuid('doc_id').notNull().references(() => documents.id, {
      onDelete: 'cascade',
    }),
    parent_id: uuid('parent_id'),                 // self-reference, nullable
    author: text('author').notNull(),             // agent_id or username
    type: commentTypeEnum('type').notNull().default('page'),
    body: text('body').notNull(),
    // Selector JSONB shape:
    // { quote: { exact: string, pre: string, post: string }, pos: { start: number, end: number } }
    // null for page-level comments
    selector: jsonb('selector'),
    round: integer('round').notNull().default(1),
    resolved: boolean('resolved').notNull().default(false),
    anchor_lost: boolean('anchor_lost').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull().defaultNow(),
    deleted_at: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    docIdx: index('idx_comments_doc_id').on(t.doc_id),
    parentIdx: index('idx_comments_parent_id').on(t.parent_id),
    authorIdx: index('idx_comments_author').on(t.author),
    roundIdx: index('idx_comments_doc_round').on(t.doc_id, t.round),
    resolvedIdx: index('idx_comments_resolved').on(t.doc_id, t.resolved),
    selfRef: foreignKey({ columns: [t.parent_id], foreignColumns: [t.id] }),
  }),
);

// ── reviews ───────────────────────────────────────────────────────────────────

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    doc_id: uuid('doc_id').notNull().references(() => documents.id, {
      onDelete: 'cascade',
    }),
    reviewer: text('reviewer').notNull(),         // agent_id or username
    status: reviewStatusEnum('status').notNull().default('pending'),
    round: integer('round').notNull().default(1),
    deadline: timestamp('deadline', { withTimezone: true }),
    notify_agent: text('notify_agent'),           // agent to ping when all done
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull().defaultNow(),
  },
  (t) => ({
    docReviewerRound: uniqueIndex('idx_reviews_doc_reviewer_round')
      .on(t.doc_id, t.reviewer, t.round),
    docStatusIdx: index('idx_reviews_doc_status').on(t.doc_id, t.status),
    deadlineIdx: index('idx_reviews_deadline').on(t.deadline),
  }),
);

// ── sessions ──────────────────────────────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull().defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true })
      .notNull().defaultNow(),
    ip: text('ip'),
    user_agent: text('user_agent'),
  },
  (t) => ({
    usernameIdx: index('idx_sessions_username').on(t.username),
    expiresIdx: index('idx_sessions_expires_at').on(t.expires_at),
  }),
);

// ── tokens (API bearer tokens for agents) ─────────────────────────────────────

export const tokens = pgTable(
  'tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),                 // human label, e.g. "claude-reviewer"
    hash: text('hash').notNull(),                 // bcrypt hash of the raw token
    agent_id: text('agent_id').notNull(),         // matches documents.agent_id
    scopes: text('scopes').array().notNull()
      .default(sql`'{read,write}'::text[]`),      // e.g. ['read','write','admin']
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }), // null = never
    revoked: boolean('revoked').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull().defaultNow(),
  },
  (t) => ({
    agentIdx: index('idx_tokens_agent_id').on(t.agent_id),
    revokedIdx: index('idx_tokens_revoked').on(t.revoked),
  }),
);

// ── agents (webhook registrations) ───────────────────────────────────────────

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),                  // e.g. "claude-reviewer" — same as agent_id
    webhook_url: text('webhook_url'),             // null = no webhook
    // HMAC-SHA256 secret stored as bcrypt hash; raw shown once at registration
    webhook_secret_hash: text('webhook_secret_hash'),
    webhook_events: text('webhook_events').array()
      .notNull().default(sql`'{}'::text[]`),      // e.g. ['review.complete','comment.created']
    active: boolean('active').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull().defaultNow(),
  },
);

// ── users (local password auth for browser) ───────────────────────────────────

export const users = pgTable(
  'users',
  {
    username: text('username').primaryKey(),
    password_hash: text('password_hash').notNull(), // bcrypt
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull().defaultNow(),
  },
);
```

### 3.2 Raw SQL: Indexes Not Expressible in Drizzle

These go in a hand-written migration file (e.g. `src/db/migrations/0002_indexes.sql`):

```sql
-- HNSW vector index for cosine similarity (pgvector 0.8+)
-- ef_construction=128 gives good recall; m=16 is default
CREATE INDEX idx_documents_embedding_hnsw
  ON documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- GIN index on tsvector column for full-text search
-- The tsvector column is maintained by a trigger (see below)
CREATE INDEX idx_documents_tsvector_gin
  ON documents
  USING gin (tsvector_col);

-- Trigger to maintain tsvector from title + content
-- Weight A = title, Weight B = content
CREATE OR REPLACE FUNCTION documents_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.tsvector_col :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_tsvector_update
  BEFORE INSERT OR UPDATE OF title, content
  ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_tsvector_trigger();

-- Composite: list docs for a project sorted by created_at (most common query)
CREATE INDEX idx_documents_project_created
  ON documents (project, created_at DESC)
  WHERE deleted_at IS NULL;

-- Composite: list docs by type + project (filtered list view)
CREATE INDEX idx_documents_type_project
  ON documents (type, project, created_at DESC)
  WHERE deleted_at IS NULL;

-- Partial index: only non-embedded docs (worker job polling)
CREATE INDEX idx_documents_pending_embed
  ON documents (created_at ASC)
  WHERE embed_status = 'pending' AND deleted_at IS NULL;

-- Comments: ordering within a doc (most common comment query)
CREATE INDEX idx_comments_doc_created
  ON comments (doc_id, created_at ASC)
  WHERE deleted_at IS NULL;

-- Reviews: deadline scan (cron-driven auto-skip job)
CREATE INDEX idx_reviews_pending_deadline
  ON reviews (deadline ASC)
  WHERE status IN ('pending', 'in_progress') AND deadline IS NOT NULL;
```

**Note on `tsvector_col`:** The Drizzle schema declares it as `text` to avoid the lack of a native tsvector type in drizzle-orm/pg-core at this time. In the migration SQL, alter the column type after initial creation:

```sql
ALTER TABLE documents
  ALTER COLUMN tsvector_col TYPE tsvector
  USING tsvector_col::tsvector;
```

Then regenerate Drizzle snapshots once the column is populated.

### 3.3 pg-boss Job Tables (Reference Only)

pg-boss manages its own schema under `pgboss.*`. The two job names used by DocVault:

| Job name | Payload type | Concurrency |
|---|---|---|
| `embed-document` | `{ docId: string }` | 1 (single worker) |
| `notify-webhook` | `{ agentId: string, event: string, docId?: string, commentId?: string }` | 4 |

---

## 4. API Route Map

The full endpoint contract — every route, request/response schema, query
parameters, auth scope, and side-effects — now lives in **[API.md](API.md)**, a
standalone API reference extracted from this section so integrators and agents
have a single self-contained file to load.

---

## 5. Embedding Worker Design

### 5.1 Architecture Overview

The Python worker is a standalone asyncio process. It does not use the pg-boss Node.js client — instead it implements the pg-boss polling protocol directly via psycopg3 (the pg-boss wire protocol is standard SQL on the `pgboss` schema).

Additionally it exposes a small HTTP server on `127.0.0.1:8001` so Fastify can request query embeddings synchronously during search.

```
worker/main.py
  │
  ├── asyncio.gather(
  │     job_handler.run_poll_loop(),      # pg-boss consumer
  │     snippet_server.run_http_server()  # aiohttp :8001
  │   )
  │
  ├── job_handler.run_poll_loop()
  │     every 2s: SELECT from pgboss.job WHERE name='embed-document'
  │               claim batch of up to 16
  │               call embedder.embed_batch(docIds)
  │               ack or fail each job
  │
  └── snippet_server.run_http_server()
        POST /embed   → embedder.embed_query(text) → [float x 768]
        POST /snippet → embedder.top_sentence(text, queryVec) → string
```

### 5.2 `worker/embedder.py`

```python
import torch
from sentence_transformers import SentenceTransformer
import re
from typing import Optional
import numpy as np

MODEL_NAME = "nomic-ai/nomic-embed-text-v1.5"
BATCH_SIZE = 16
MAX_SNIPPET_CHARS = 120
TASK_PREFIX_DOC = "search_document: "
TASK_PREFIX_QUERY = "search_query: "

class Embedder:
    def __init__(self, model_path: str, device: str = "cuda"):
        self.device = device
        self.model = SentenceTransformer(
            model_path,
            trust_remote_code=True,    # nomic requires this
            device=device,
        )
        self.model_version = "nomic-embed-text-v1.5"

    def embed_documents(self, texts: list[str]) -> np.ndarray:
        """Embed a batch of document texts. Adds task prefix per nomic spec."""
        prefixed = [TASK_PREFIX_DOC + t for t in texts]
        with torch.inference_mode():
            vecs = self.model.encode(
                prefixed,
                batch_size=BATCH_SIZE,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        return vecs  # shape: (N, 768), float32

    def embed_query(self, text: str) -> list[float]:
        """Embed a single search query. Used by HTTP /embed endpoint."""
        prefixed = TASK_PREFIX_QUERY + text
        with torch.inference_mode():
            vec = self.model.encode(
                [prefixed],
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        return vec[0].tolist()

    def word_count(self, text: str) -> int:
        return len(re.findall(r'\S+', text))

    def split_sentences(self, text: str) -> list[str]:
        """
        Naive sentence splitter sufficient for markdown prose.
        Splits on '. ', '? ', '! ', or newline followed by capital.
        Strips leading/trailing whitespace from each sentence.
        """
        parts = re.split(r'(?<=[.?!])\s+(?=[A-Z])|(?<=\n)\n+', text)
        return [p.strip() for p in parts if p.strip()]

    def top_sentence_snippet(
        self, doc_text: str, query_vec: list[float]
    ) -> str:
        """
        For semantic search snippets: find the sentence in doc_text whose
        embedding has the highest cosine similarity to query_vec.
        Returns up to MAX_SNIPPET_CHARS characters.
        """
        sentences = self.split_sentences(doc_text)
        if not sentences:
            return doc_text[:MAX_SNIPPET_CHARS]

        query_np = np.array(query_vec, dtype=np.float32)
        # Embed all sentences in one batch
        with torch.inference_mode():
            sent_vecs = self.model.encode(
                [TASK_PREFIX_DOC + s for s in sentences],
                normalize_embeddings=True,
                show_progress_bar=False,
            )
        # Cosine similarity (vectors already normalised)
        sims = sent_vecs @ query_np
        best_idx = int(np.argmax(sims))
        best = sentences[best_idx]
        return best[:MAX_SNIPPET_CHARS]

    def keyword_snippet(self, doc_text: str, query_terms: list[str]) -> str:
        """
        For keyword search snippets: find the first sentence containing
        any query term (case-insensitive). Falls back to first sentence.
        Returns up to MAX_SNIPPET_CHARS characters.
        """
        sentences = self.split_sentences(doc_text)
        lower_terms = [t.lower() for t in query_terms]
        for sentence in sentences:
            if any(t in sentence.lower() for t in lower_terms):
                return sentence[:MAX_SNIPPET_CHARS]
        return (sentences[0] if sentences else doc_text)[:MAX_SNIPPET_CHARS]
```

### 5.3 `worker/job_handler.py`

```python
import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
import psycopg
from psycopg.rows import dict_row
from embedder import Embedder

log = logging.getLogger(__name__)

POLL_INTERVAL_S = 2
JOB_NAME = "embed-document"
BATCH_SIZE = 16
JOB_TIMEOUT_S = 120   # pg-boss expireInSeconds must match

class JobHandler:
    def __init__(self, db_url: str, embedder: Embedder):
        self.db_url = db_url
        self.embedder = embedder

    async def run_poll_loop(self):
        while True:
            try:
                await self._poll_and_process()
            except Exception as e:
                log.error("Poll loop error: %s", e, exc_info=True)
            await asyncio.sleep(POLL_INTERVAL_S)

    async def _poll_and_process(self):
        async with await psycopg.AsyncConnection.connect(
            self.db_url, row_factory=dict_row
        ) as conn:
            # Claim up to BATCH_SIZE jobs atomically
            rows = await self._claim_jobs(conn, BATCH_SIZE)
            if not rows:
                return

            doc_ids = [r['data']['docId'] for r in rows]
            job_ids = [r['id'] for r in rows]

            log.info("Processing %d embed jobs: %s", len(doc_ids), doc_ids)

            # Fetch document content
            docs = await self._fetch_docs(conn, doc_ids)

            if not docs:
                await self._fail_jobs(conn, job_ids, "Documents not found")
                return

            # Build texts for embedding: title + "\n\n" + content
            texts = [f"{d['title']}\n\n{d['content']}" for d in docs]
            try:
                vectors = self.embedder.embed_documents(texts)
            except Exception as e:
                log.error("Embedding failed: %s", e)
                await self._fail_jobs(conn, job_ids, str(e))
                return

            # Write vectors back and ack jobs
            for doc, vec in zip(docs, vectors):
                word_count = self.embedder.word_count(doc['content'])
                await conn.execute(
                    """
                    UPDATE documents SET
                        embedding = %s::vector,
                        embed_status = 'ready',
                        embed_model = %s,
                        words = %s,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (vec.tolist(), self.embedder.model_version,
                     word_count, doc['id'])
                )
            await conn.commit()
            await self._ack_jobs(conn, job_ids)

    async def _claim_jobs(self, conn, batch_size: int) -> list[dict]:
        """
        pg-boss job claim: UPDATE ... RETURNING using pg-boss internal schema.
        Sets state='active', startedOn=now(), retryCount incremented.
        """
        rows = await conn.execute(
            """
            WITH batch AS (
              SELECT id FROM pgboss.job
              WHERE name = %s
                AND state = 'created'
                AND (startafter IS NULL OR startafter <= now())
              ORDER BY priority DESC, createdon ASC
              LIMIT %s
              FOR UPDATE SKIP LOCKED
            )
            UPDATE pgboss.job j SET
              state = 'active',
              startedon = now(),
              expirein = %s::interval
            FROM batch WHERE j.id = batch.id
            RETURNING j.id, j.data
            """,
            (JOB_NAME, batch_size, f'{JOB_TIMEOUT_S} seconds')
        ).fetchall()
        return rows

    async def _ack_jobs(self, conn, job_ids: list):
        await conn.execute(
            "UPDATE pgboss.job SET state='completed', completedon=now() "
            "WHERE id = ANY(%s)",
            (job_ids,)
        )
        await conn.commit()

    async def _fail_jobs(self, conn, job_ids: list, reason: str):
        await conn.execute(
            "UPDATE pgboss.job SET state='failed', output=%s::jsonb "
            "WHERE id = ANY(%s)",
            (json.dumps({"error": reason}), job_ids)
        )
        await conn.commit()

    async def _fetch_docs(self, conn, doc_ids: list) -> list[dict]:
        rows = await conn.execute(
            "SELECT id, title, content FROM documents WHERE id = ANY(%s)",
            (doc_ids,)
        ).fetchall()
        return rows
```

### 5.4 `worker/snippet_server.py`

```python
from aiohttp import web
import json
from embedder import Embedder

class SnippetServer:
    def __init__(self, embedder: Embedder, host: str = "127.0.0.1", port: int = 8001):
        self.embedder = embedder
        self.host = host
        self.port = port

    async def handle_embed(self, request: web.Request) -> web.Response:
        body = await request.json()
        text = body.get("text", "")
        if not text:
            return web.Response(status=400, text="text required")
        vec = self.embedder.embed_query(text)
        return web.Response(
            content_type="application/json",
            text=json.dumps({"embedding": vec})
        )

    async def handle_snippet(self, request: web.Request) -> web.Response:
        body = await request.json()
        mode = body.get("mode", "semantic")
        doc_text = body.get("text", "")
        if mode == "semantic":
            query_vec = body.get("query_vec", [])
            snippet = self.embedder.top_sentence_snippet(doc_text, query_vec)
        else:
            terms = body.get("terms", [])
            snippet = self.embedder.keyword_snippet(doc_text, terms)
        return web.Response(
            content_type="application/json",
            text=json.dumps({"snippet": snippet})
        )

    async def run_http_server(self):
        app = web.Application()
        app.router.add_post("/embed", self.handle_embed)
        app.router.add_post("/snippet", self.handle_snippet)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, self.host, self.port)
        await site.start()
        # Keep running indefinitely (asyncio.gather will hold it)
        import asyncio
        while True:
            await asyncio.sleep(3600)
```

### 5.5 `worker/main.py`

```python
import asyncio
import logging
import os
from embedder import Embedder
from job_handler import JobHandler
from snippet_server import SnippetServer
from config import get_config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s"
)

async def main():
    cfg = get_config()
    embedder = Embedder(
        model_path=cfg["model_path"],
        device=cfg["device"],
    )
    handler = JobHandler(db_url=cfg["db_url"], embedder=embedder)
    server = SnippetServer(
        embedder=embedder,
        host="127.0.0.1",
        port=cfg["worker_port"],
    )
    logging.info("DocVault worker starting. Model: %s Device: %s",
                 embedder.model_version, cfg["device"])
    await asyncio.gather(
        handler.run_poll_loop(),
        server.run_http_server(),
    )

if __name__ == "__main__":
    asyncio.run(main())
```

### 5.6 Degraded Mode

When the Python worker is down:
- Fastify's `worker-client.ts` catches connection refused errors on `127.0.0.1:8001`
- Search falls back to keyword-only mode (no query embedding needed)
- Snippet generation uses the keyword path (no worker call)
- Response includes `"mode": "keyword"` in search results to signal degraded state
- All enqueue operations still succeed (pg-boss persists jobs)
- When worker restarts it processes all accumulated `embed-document` jobs

---

## 6. Web UI Architecture

### 6.1 Component Tree

```
App (React Router v7)
├── Layout
│   ├── Sidebar
│   │   ├── ProjectList        (nav: projects)
│   │   ├── SearchBox          (inline search)
│   │   └── NavLinks           (admin, tokens)
│   └── <Outlet />
│
├── /                          → DocList
├── /docs/new                  → DocEditor (create mode)
├── /docs/:id                  → DocViewer
│   ├── MarkdownRenderer       (renders HTML + injects data-block-ids)
│   ├── AnnotatorMount         (mounts text-annotator-js over rendered DOM)
│   └── CommentPanel           (sliding panel, portal)
│       ├── CommentThread[]
│       │   ├── CommentItem
│       │   └── ReplyForm
│       └── AddCommentForm
├── /docs/:id/edit             → DocEditor (edit mode)
├── /search                    → SearchResults
│   ├── FilterBar
│   └── SearchResultItem[]
├── /admin/tokens              → TokenManager
└── /login                     → LoginForm
```

### 6.2 Annotator Integration (`src/ui/src/hooks/useAnnotator.ts`)

```typescript
import { useEffect, useRef } from 'react';
import { createTextAnnotator } from '@recogito/text-annotator';
import type { TextAnnotation } from '@recogito/text-annotator';
import { apiClient } from '../api/client';

interface UseAnnotatorOptions {
  docId: string;
  containerRef: React.RefObject<HTMLElement>;
  onAnnotationCreated: (annotation: TextAnnotation) => void;
}

export function useAnnotator({ docId, containerRef, onAnnotationCreated }: UseAnnotatorOptions) {
  const annotatorRef = useRef<ReturnType<typeof createTextAnnotator> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const anno = createTextAnnotator(containerRef.current, {
      style: { color: '#f59e0b', fill: '#fef3c7' },
    });

    annotatorRef.current = anno;

    // Load existing comments as annotations
    apiClient.get<{ data: Comment[] }>(`/documents/${docId}/comments?type=inline`)
      .then(({ data }) => {
        const annotations = data
          .filter(c => c.selector)
          .map(commentToAnnotation);
        anno.setAnnotations(annotations);
      });

    anno.on('createAnnotation', async (annotation: TextAnnotation) => {
      const range = annotation.target.selector;
      // Convert recogito selector to DocVault selector shape
      const selector = {
        quote: {
          exact: range.exact,
          pre: range.prefix ?? '',
          post: range.suffix ?? '',
        },
        pos: { start: range.start, end: range.end },
      };
      onAnnotationCreated({ ...annotation, _docvaultSelector: selector });
    });

    anno.on('deleteAnnotation', async (annotation: TextAnnotation) => {
      // comment id stored in annotation body
      const commentId = annotation.id;
      await apiClient.delete(`/documents/${docId}/comments/${commentId}`);
    });

    return () => {
      anno.destroy();
    };
  }, [docId, containerRef]);

  return annotatorRef;
}

function commentToAnnotation(comment: Comment): TextAnnotation {
  return {
    id: comment.id,
    type: 'Annotation',
    body: [{ type: 'TextualBody', value: comment.body, purpose: 'commenting' }],
    target: {
      selector: {
        type: 'TextQuoteSelector',
        exact: comment.selector.quote.exact,
        prefix: comment.selector.quote.pre,
        suffix: comment.selector.quote.post,
        start: comment.selector.pos.start,
        end: comment.selector.pos.end,
      },
    },
  };
}
```

**Touch fallback:** recogito/text-annotator-js supports pointer events natively. On touch devices the selection UI uses the browser's native touch selection. No additional fallback code is required — the annotator detects pointer type internally.

**anchor_lost handling:** When a comment has `anchor_lost: true`, the CommentPanel renders it without a highlight highlight (the annotation is not loaded into the annotator). A warning badge is shown in the comment thread: "Anchor lost — document was updated after this comment was placed."

### 6.3 State Management

```typescript
// src/ui/src/store/ui.ts  (Zustand)
interface UIState {
  darkMode: boolean;
  toggleDarkMode: () => void;
  commentPanelOpen: boolean;
  setCommentPanelOpen: (open: boolean) => void;
  activeAnnotationId: string | null;
  setActiveAnnotationId: (id: string | null) => void;
  // When user creates annotation, store pending selector until comment is submitted
  pendingSelector: DocvaultSelector | null;
  setPendingSelector: (s: DocvaultSelector | null) => void;
}
```

Dark mode: toggling `data-theme="dark"` on `<html>`. CSS variables in `global.css` switch palette. Persisted to `localStorage.setItem('theme', ...)`.

### 6.4 Markdown Rendering Pipeline

The `remark → rehype` pipeline runs **server-side at write time** (in `src/api/lib/markdown.ts`). The processed HTML with `data-block-id` attributes is stored — not reprocessed on each read. The stored HTML field is not in the DB schema (markdown is canonical); instead, the processing happens in the GET endpoint and the result is cached in a short-lived in-memory LRU (1000 entries, 5 min TTL) keyed by `id + version`.

```typescript
// src/api/lib/markdown.ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root } from 'hast';

let blockCounter = 0;

function remarkBlockIds() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if (['paragraph', 'heading', 'listItem', 'blockquote', 'code'].includes(node.type)) {
        if (!node.data) node.data = {};
        if (!node.data.hProperties) node.data.hProperties = {};
        // Stable: use position in source
        const pos = node.position;
        const blockId = pos
          ? `b-${pos.start.line}-${pos.start.column}`
          : `b-${++blockCounter}`;
        (node.data.hProperties as Record<string, string>)['data-block-id'] = blockId;
      }
    });
  };
}

const pipeline = unified()
  .use(remarkParse)
  .use(remarkBlockIds)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeStringify);

export async function renderMarkdown(content: string): Promise<string> {
  const result = await pipeline.process(content);
  return String(result);
}
```

### 6.5 Comment Side Panel State

The `CommentPanel` is a right-side drawer (`position: fixed; right: 0`). When the annotator fires `clickAnnotation`, the matching comment thread scrolls into view in the panel. When a new annotation is created (user selects text), the panel opens automatically and focuses the `AddCommentForm` with `pendingSelector` pre-filled. Submitting the form calls `POST /api/v1/documents/:id/comments` and then calls `anno.setAnnotations(...)` to persist the highlight.

---

## 7. Authentication Flow

### 7.1 Bearer Token Issuance

```
CLI: docvault admin token create --name "claude-reviewer" --agent-id "claude" --scopes read,write

1. CLI generates raw token:
     const raw = `dv_${crypto.randomBytes(32).toString('hex')}`;
     // Result: "dv_" + 64 hex chars = 67 character string

2. CLI bcrypt-hashes the raw token:
     const hash = await bcrypt.hash(raw, 12);

3. CLI INSERTs into tokens table:
     { name, hash, agent_id, scopes, expires_at }

4. CLI prints raw token to stdout ONCE — never stored in plaintext.
```

### 7.2 Bearer Token Verification

```typescript
// src/api/plugins/auth.ts  (simplified)
async function verifyBearerToken(
  token: string,
  db: DrizzleDB
): Promise<TokenRow | null> {
  // Tokens start with "dv_" — use prefix to narrow candidates
  // We cannot use bcrypt prefix lookup; instead maintain a SHA256 lookup hash
  // alongside the bcrypt hash for O(1) candidate lookup:
  const lookupHash = crypto.createHash('sha256').update(token).digest('hex');

  const row = await db.query.tokens.findFirst({
    where: and(
      eq(tokens.lookup_hash, lookupHash),
      eq(tokens.revoked, false),
      or(isNull(tokens.expires_at), gt(tokens.expires_at, sql`now()`))
    ),
  });

  if (!row) return null;

  // bcrypt verify as second factor (collision resistance)
  const valid = await bcrypt.compare(token, row.hash);
  if (!valid) return null;

  // Update last_used_at (fire-and-forget, non-blocking)
  db.update(tokens)
    .set({ last_used_at: sql`now()` })
    .where(eq(tokens.id, row.id))
    .execute()
    .catch(() => {});

  return row;
}
```

**Note:** The `tokens` table requires an additional `lookup_hash text` column (SHA256 of raw token) with a unique index. This enables O(1) lookup before the expensive bcrypt comparison. Add to schema:

```typescript
lookup_hash: text('lookup_hash').notNull().unique(),
```

And add to the issuance flow:
```typescript
const lookupHash = crypto.createHash('sha256').update(raw).digest('hex');
```

### 7.3 Session Cookie Flow

```
Browser login:
1. POST /api/v1/auth/login { username, password }
2. Fastify fetches user row, bcrypt.compare(password, password_hash)
3. On success: generates session ID = crypto.randomUUID()
4. INSERTs into sessions: { id, username, expires_at: now() + 7 days }
5. Sets cookie: docvault_session=<id>; HttpOnly; Secure; SameSite=Strict; Max-Age=604800

Session validation (preHandler hook):
1. Read cookie docvault_session
2. SELECT * FROM sessions WHERE id = $1 AND expires_at > now()
3. If found: slide expiry → UPDATE sessions SET expires_at = now() + 7 days, last_seen_at = now()
4. Attach { username, role: 'user' } to request.user

Logout:
1. DELETE FROM sessions WHERE id = $1
2. Set-Cookie: docvault_session=; Max-Age=0
```

### 7.4 HMAC Webhook Signing

```typescript
// src/api/lib/webhook.ts
import { createHmac } from 'crypto';

export function signPayload(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = signPayload(secret, body);
  // Constant-time comparison
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// Secret generation (at agent registration):
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

// Secret is shown raw once, then stored as bcrypt hash:
// await bcrypt.hash(rawSecret, 12) → stored in agents.webhook_secret_hash
// Actual HMAC signing uses the raw secret (kept in memory after fetch / never re-read).
// RESOLUTION: the raw secret is NOT stored. Instead, store it as is and use AES-256-GCM
// encryption (key from DOCVAULT_SECRET_KEY env var) rather than bcrypt, since bcrypt
// is a one-way hash and cannot be reversed for signing. See ADR-06.
```

**Corrected storage approach (see ADR-06):** Webhook secrets are stored AES-256-GCM encrypted in `agents.webhook_secret_enc` (not bcrypt-hashed), because the plaintext must be recovered to compute HMAC signatures.

```typescript
// src/api/lib/crypto.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALG = 'aes-256-gcm';

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');   // 32 bytes
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Encode as iv:tag:ciphertext (all hex)
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

export function decryptSecret(encoded: string, keyHex: string): string {
  const [ivHex, tagHex, ctHex] = encoded.split(':');
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString('utf8') + decipher.final('utf8');
}
```

### 7.5 Webhook Retry Logic

Webhooks are dispatched via pg-boss `notify-webhook` jobs. The retry schedule is external to pg-boss built-in retry (which only retries on worker failure). Instead:

```typescript
// src/api/lib/webhook.ts
async function dispatchWebhook(agent: Agent, payload: WebhookPayload, boss: PgBoss) {
  const body = JSON.stringify(payload);
  const secret = decryptSecret(agent.webhook_secret_enc, process.env.DOCVAULT_SECRET_KEY!);
  const signature = signPayload(secret, body);

  // Try immediate dispatch
  try {
    const res = await fetch(agent.webhook_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DocVault-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return;
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Schedule retries at 1s, 4s, 16s delays
    const delays = [1, 4, 16];
    for (const delaySec of delays) {
      await boss.sendAfter(
        'notify-webhook',
        { agentId: agent.id, payload, attempt: delays.indexOf(delaySec) + 1 },
        {},
        delaySec
      );
    }
  }
}
```

### 7.6 CLI Commands

```typescript
// src/cli/commands/token.ts
program
  .command('token')
  .command('create')
  .requiredOption('--name <name>')
  .requiredOption('--agent-id <agentId>')
  .option('--scopes <scopes>', 'comma-separated', 'read,write')
  .option('--expires <iso8601>')
  .action(async (opts) => {
    const raw = `dv_${randomBytes(32).toString('hex')}`;
    const hash = await bcrypt.hash(raw, 12);
    const lookupHash = createHash('sha256').update(raw).digest('hex');
    const db = await connectDb();
    const [row] = await db.insert(tokens).values({
      name: opts.name,
      agent_id: opts.agentId,
      hash,
      lookup_hash: lookupHash,
      scopes: opts.scopes.split(','),
      expires_at: opts.expires ? new Date(opts.expires) : null,
    }).returning({ id: tokens.id });
    console.log(`Token ID: ${row.id}`);
    console.log(`Token (save this — shown once): ${raw}`);
    process.exit(0);
  });

// src/cli/commands/user.ts
program
  .command('user')
  .command('set-password')
  .requiredOption('--username <username>')
  .action(async (opts) => {
    const password = await promptPassword('New password: ');
    const hash = await bcrypt.hash(password, 12);
    const db = await connectDb();
    await db.insert(users)
      .values({ username: opts.username, password_hash: hash })
      .onConflictDoUpdate({
        target: users.username,
        set: { password_hash: hash, updated_at: sql`now()` },
      });
    console.log(`Password set for ${opts.username}`);
    process.exit(0);
  });
```

---

## 8. Configuration

### 8.1 `config/docvault.yaml`

```yaml
# DocVault application configuration
# All values can be overridden by DOCVAULT_* environment variables.
# Env var naming: nested keys joined by _ and uppercased, prefixed with DOCVAULT_
# Example: server.port → DOCVAULT_SERVER_PORT

server:
  host: "127.0.0.1"           # DOCVAULT_SERVER_HOST — bind address for Fastify
  port: 3000                   # DOCVAULT_SERVER_PORT
  log_level: "info"            # DOCVAULT_SERVER_LOG_LEVEL — trace|debug|info|warn|error
  body_limit: 2097152          # DOCVAULT_SERVER_BODY_LIMIT — bytes, default 2MB

database:
  url: ""                      # DOCVAULT_DATABASE_URL — postgresql://user:pass@host:5432/dbname
  pool_min: 2                  # DOCVAULT_DATABASE_POOL_MIN
  pool_max: 10                 # DOCVAULT_DATABASE_POOL_MAX
  pool_idle_timeout_ms: 30000  # DOCVAULT_DATABASE_POOL_IDLE_TIMEOUT_MS

worker:
  url: "http://127.0.0.1:8001" # DOCVAULT_WORKER_URL — Python worker HTTP endpoint
  timeout_ms: 5000             # DOCVAULT_WORKER_TIMEOUT_MS — per-request timeout

auth:
  session_ttl_seconds: 604800  # DOCVAULT_AUTH_SESSION_TTL_SECONDS — 7 days
  session_cookie_name: "docvault_session"  # DOCVAULT_AUTH_SESSION_COOKIE_NAME
  secret_key: ""               # DOCVAULT_AUTH_SECRET_KEY — 32-byte hex, for AES-256-GCM

search:
  default_limit: 10            # DOCVAULT_SEARCH_DEFAULT_LIMIT
  max_limit: 50                # DOCVAULT_SEARCH_MAX_LIMIT
  rrf_k: 60                    # DOCVAULT_SEARCH_RRF_K
  ef_search: 100               # DOCVAULT_SEARCH_EF_SEARCH

embedding:
  model: "nomic-ai/nomic-embed-text-v1.5"  # DOCVAULT_EMBEDDING_MODEL
  model_path: "~/.cache/docvault/models"  # DOCVAULT_EMBEDDING_MODEL_PATH
  device: "cuda"               # DOCVAULT_EMBEDDING_DEVICE — cuda|cpu
  batch_size: 16               # DOCVAULT_EMBEDDING_BATCH_SIZE
  worker_port: 8001            # DOCVAULT_EMBEDDING_WORKER_PORT

rate_limit:
  max: 200                     # DOCVAULT_RATE_LIMIT_MAX — requests per window
  time_window_ms: 60000        # DOCVAULT_RATE_LIMIT_TIME_WINDOW_MS

jobs:
  # pg-boss configuration
  expireInSeconds: 120         # DOCVAULT_JOBS_EXPIRE_IN_SECONDS
  retentionDays: 7             # DOCVAULT_JOBS_RETENTION_DAYS

ui:
  serve: true                  # DOCVAULT_UI_SERVE — whether Fastify serves the SPA
  dist_path: "./dist/ui"       # DOCVAULT_UI_DIST_PATH

lru_cache:
  max_size: 1000               # DOCVAULT_LRU_CACHE_MAX_SIZE — markdown render cache entries
  ttl_ms: 300000               # DOCVAULT_LRU_CACHE_TTL_MS — 5 minutes
```

### 8.2 `config/.env.example`

```bash
# Copy to .env and fill in values. Never commit .env.

# PostgreSQL connection
DOCVAULT_DATABASE_URL=postgresql://docvault:changeme@localhost:5432/docvault

# 32-byte random hex — generate with: openssl rand -hex 32
DOCVAULT_AUTH_SECRET_KEY=

# Fastify listen address (do not change unless you know what you're doing)
DOCVAULT_SERVER_HOST=127.0.0.1
DOCVAULT_SERVER_PORT=3000

# Python worker URL
DOCVAULT_WORKER_URL=http://127.0.0.1:8001

# Embedding device: cuda (RTX 3050) or cpu
DOCVAULT_EMBEDDING_DEVICE=cuda
DOCVAULT_EMBEDDING_MODEL_PATH=~/.cache/docvault/models

# Log level: trace|debug|info|warn|error
DOCVAULT_SERVER_LOG_LEVEL=info

# Node environment
NODE_ENV=production
```

---

## 9. Systemd Service Definitions

### 9.1 `infra/docvault-api.service`

```ini
[Unit]
Description=DocVault API Server (Fastify)
Documentation=https://github.com/your-org/docvault
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=docvault
Group=docvault
WorkingDirectory=~/docvault
EnvironmentFile=~/docvault/.env
ExecStart=/usr/bin/node \
  --enable-source-maps \
  dist/api/index.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docvault-api

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=~/docvault
PrivateTmp=true
PrivateDevices=true

# Resource limits
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### 9.2 `infra/docvault-worker.service`

```ini
[Unit]
Description=DocVault Embedding Worker (Python/GPU)
Documentation=https://github.com/your-org/docvault
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=docvault
Group=docvault
WorkingDirectory=~/docvault/worker
EnvironmentFile=~/docvault/.env
Environment=PYTHONUNBUFFERED=1
Environment=CUDA_VISIBLE_DEVICES=0
ExecStart=~/ml-env/bin/python main.py
Restart=on-failure
RestartSec=10s
# Give the model time to load before marking as active
TimeoutStartSec=120
StandardOutput=journal
StandardError=journal
SyslogIdentifier=docvault-worker

# GPU access requires access to /dev/dri and /dev/nvidia*
# Do NOT use PrivateDevices=true here
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=~/.cache/docvault
PrivateTmp=true

# Resource limits
LimitNOFILE=32768

[Install]
WantedBy=multi-user.target
```

---

## 10. Caddy Configuration

### `infra/Caddyfile`

```caddyfile
# DocVault — Tailscale-only HTTPS
# Caddy handles TLS via its internal CA (tailscale cert or self-signed for LAN)

{
  # Disable Caddy's Let's Encrypt ACME (Tailscale handles certs)
  # If using tailscale cert: replace with `tls /path/to/cert /path/to/key`
  auto_https off
  admin off
}

# Bind to Tailscale interface IP
# Replace 100.x.x.x with actual Tailscale IP from `tailscale ip -4`
https://100.x.x.x:443 {

  # Restrict access to Tailscale CIDR ranges only
  # Tailscale uses 100.64.0.0/10 for device IPs and 100.100.100.100 for MagicDNS
  @allowed_cidr {
    remote_ip 100.64.0.0/10 100.0.0.0/8
  }

  # Block all non-Tailscale requests
  respond @allowed_cidr "" 403 {
    body "Access denied"
    close
  }

  # Actually the above logic is inverted — use a not-matcher:
  @not_tailscale {
    not remote_ip 100.64.0.0/10 100.0.0.0/8
  }
  respond @not_tailscale "Access denied" 403 {
    close
  }

  # TLS — use Tailscale-provisioned certificate
  # Run: sudo tailscale cert <your-tailscale-hostname>
  # This creates /var/lib/tailscale/certs/<hostname>.crt and .key
  tls /var/lib/tailscale/certs/{$TAILSCALE_HOSTNAME}.crt \
      /var/lib/tailscale/certs/{$TAILSCALE_HOSTNAME}.key

  # Security headers
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }

  # Proxy to Fastify
  reverse_proxy 127.0.0.1:3000 {
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-Proto {scheme}
    # Health check for upstream
    health_uri /health
    health_interval 15s
    health_timeout 5s
  }

  # Logging
  log {
    output file /var/log/caddy/docvault.log {
      roll_size 50mb
      roll_keep 5
    }
    format json
  }
}

# Redirect HTTP to HTTPS
http://100.x.x.x:80 {
  redir https://100.x.x.x{uri} permanent
}
```

**Setup note:** Before running Caddy, provision the Tailscale cert:

```bash
sudo tailscale cert $(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')
# Sets TAILSCALE_HOSTNAME in the environment or hard-code the hostname in Caddyfile
```

---

## 11. Install Script Outline

### `scripts/install.sh`

```bash
#!/usr/bin/env bash
# DocVault Install Script — Ubuntu 24.04
# Run as the application user, not root.
# Idempotent: safe to re-run.

set -euo pipefail
REPO_DIR="$HOME/docvault"
VENV_DIR="$HOME/ml-env"
MODEL_CACHE="$HOME/.cache/docvault/models"

# ── Step 1: PostgreSQL 16 + pgvector ─────────────────────────────────────────
echo "[1/11] Installing PostgreSQL 16 + pgvector..."
sudo apt-get update -qq
sudo apt-get install -y postgresql-16 postgresql-16-pgvector libpq-dev

# Ensure PostgreSQL is running
sudo systemctl enable --now postgresql

# Create database and user
sudo -u postgres psql <<'SQL'
DO $$BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docvault') THEN
    CREATE ROLE docvault WITH LOGIN PASSWORD 'changeme';
  END IF;
END$$;

DO $$BEGIN
  IF NOT EXISTS (SELECT FROM pg_database WHERE datname = 'docvault') THEN
    CREATE DATABASE docvault OWNER docvault;
  END IF;
END$$;
SQL

# Enable pgvector extension inside docvault database
sudo -u postgres psql -d docvault -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d docvault -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# ── Step 2: Node.js 22 ────────────────────────────────────────────────────────
echo "[2/11] Verifying Node.js 22..."
node --version | grep -q "^v22" || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
}

# ── Step 3: Python 3.12 + venv + CUDA deps ───────────────────────────────────
echo "[3/11] Setting up Python venv..."
sudo apt-get install -y python3.12 python3.12-venv python3.12-dev

# Create venv if not exists
if [ ! -d "$VENV_DIR" ]; then
  python3.12 -m venv "$VENV_DIR"
fi

# CUDA toolkit check (must be installed separately before this point)
# Verify: nvcc --version should show CUDA 12.x
nvcc --version || echo "WARNING: CUDA not found. GPU embedding will fail."

# ── Step 4: Node dependencies ────────────────────────────────────────────────
echo "[4/11] Installing Node dependencies..."
cd "$REPO_DIR"
npm ci --workspace=src/api --workspace=src/ui

# ── Step 5: Python dependencies ──────────────────────────────────────────────
echo "[5/11] Installing Python dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$REPO_DIR/worker/requirements.txt"
# sentence-transformers with CUDA support:
"$VENV_DIR/bin/pip" install torch --index-url https://download.pytorch.org/whl/cu121

# ── Step 6: Download embedding model ─────────────────────────────────────────
echo "[6/11] Downloading nomic-embed-text-v1.5 model..."
mkdir -p "$MODEL_CACHE"
"$VENV_DIR/bin/python" - <<'PYEOF'
from sentence_transformers import SentenceTransformer
import os
model_path = os.path.expanduser("~/.cache/docvault/models")
model = SentenceTransformer(
    "nomic-ai/nomic-embed-text-v1.5",
    trust_remote_code=True,
    cache_folder=model_path
)
print("Model downloaded to:", model_path)
PYEOF

# ── Step 7: Build TypeScript ──────────────────────────────────────────────────
echo "[7/11] Building TypeScript API..."
cd "$REPO_DIR"
npm run build --workspace=src/api
npm run build --workspace=src/ui

# ── Step 8: Database migrations ──────────────────────────────────────────────
echo "[8/11] Running database migrations..."
cd "$REPO_DIR"
# Copy .env.example to .env if not present
if [ ! -f .env ]; then
  cp config/.env.example .env
  echo "Created .env — edit it now with real values before continuing."
  echo "Especially set DOCVAULT_DATABASE_URL and DOCVAULT_AUTH_SECRET_KEY"
  read -r -p "Press Enter after editing .env..."
fi

# Generate secret key if not set
source .env
if [ -z "${DOCVAULT_AUTH_SECRET_KEY:-}" ]; then
  SECRET=$(openssl rand -hex 32)
  sed -i "s/DOCVAULT_AUTH_SECRET_KEY=$/DOCVAULT_AUTH_SECRET_KEY=$SECRET/" .env
  echo "Generated DOCVAULT_AUTH_SECRET_KEY"
fi

# Apply Drizzle migrations
npx drizzle-kit migrate

# Apply raw SQL indexes (idempotent with IF NOT EXISTS or CREATE IF NOT EXISTS)
PGPASSWORD="${PGPASSWORD:-changeme}" psql \
  "${DOCVAULT_DATABASE_URL}" \
  -f "$REPO_DIR/src/db/migrations/0002_indexes.sql"

# ── Step 9: Create admin user ─────────────────────────────────────────────────
echo "[9/11] Creating admin user..."
node dist/api/cli/index.js admin user set-password --username admin

# Create initial admin token
echo "Creating admin API token..."
node dist/api/cli/index.js admin token create \
  --name "admin" \
  --agent-id "admin" \
  --scopes "read,write,admin"

# ── Step 10: Caddy setup ──────────────────────────────────────────────────────
echo "[10/11] Setting up Caddy..."
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -qq && sudo apt-get install -y caddy

sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy

# Provision Tailscale cert
TAILSCALE_HOSTNAME=$(tailscale status --json | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d['Self']['DNSName'].rstrip('.'))")
sudo tailscale cert "$TAILSCALE_HOSTNAME"

# Copy and activate Caddyfile
sudo cp "$REPO_DIR/infra/Caddyfile" /etc/caddy/Caddyfile
# Substitute actual hostname
sudo sed -i "s/100.x.x.x/$(tailscale ip -4)/g" /etc/caddy/Caddyfile
sudo sed -i "s/\${TAILSCALE_HOSTNAME}/$TAILSCALE_HOSTNAME/g" /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy

# ── Step 11: systemd services ─────────────────────────────────────────────────
echo "[11/11] Enabling systemd services..."
sudo cp "$REPO_DIR/infra/docvault-api.service" /etc/systemd/system/
sudo cp "$REPO_DIR/infra/docvault-worker.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now docvault-api
sudo systemctl enable --now docvault-worker

echo ""
echo "=== DocVault installed successfully ==="
echo "API:    https://$(tailscale ip -4)"
echo "Status: systemctl status docvault-api docvault-worker"
echo "Logs:   journalctl -u docvault-api -u docvault-worker -f"
```

### `worker/requirements.txt`

```
sentence-transformers>=2.7.0
psycopg[binary]>=3.1.19
aiohttp>=3.9.5
numpy>=1.26.4
# torch installed separately (CUDA wheel)
```

---

## 12. Key Design Decisions

### ADR-01: pg-boss via Direct SQL in Python Worker (not Node.js client)

**Context:** pg-boss has an official Node.js client. The Python worker needs to consume jobs from the same queue.

**Decision:** The Python worker implements the pg-boss job claim protocol directly via psycopg3 SQL (`SELECT ... FOR UPDATE SKIP LOCKED` on `pgboss.job`). The pg-boss Node.js client is used only in the Fastify API to enqueue jobs.

**Alternatives rejected:**
- REST sidecar (Node.js process the Python worker calls via HTTP): adds a third process, deployment complexity, and a failure domain.
- Redis/Celery: introduces a second message broker, contradicts the "no Docker, minimal moving parts" constraint.

**Consequences:** The pg-boss internal schema must be treated as stable API surface. Pin pg-boss to a major version and validate after upgrades. The `pgboss.job` table structure is documented in pg-boss source and has been stable across v9/v10.

---

### ADR-02: Sentence-level Snippet Generation via GPU Worker

**Context:** Search snippets must be max 120 chars. Semantic search requires identifying the most relevant passage in a document without returning the whole doc.

**Decision:** For semantic snippets, the Python worker's HTTP endpoint (`/snippet`) receives the document text and query vector, splits into sentences, embeds all sentences in one batch (GPU), and returns the sentence with highest cosine similarity to the query. Keyword snippets use a regex sentence splitter with term matching (no GPU needed).

**Alternatives rejected:**
- Pre-compute sentence embeddings for every sentence at ingest time: storage cost is O(sentences × 768 × 4 bytes) per document — prohibitive at 50k docs averaging 100 sentences each (~150GB).
- Extract snippet in Fastify (Node.js, CPU): no GPU access, would require shipping the model to JS (onnxruntime-node), adds complexity.

**Consequences:** Semantic search adds one HTTP round-trip to the worker per query (< 50ms on warm GPU for most docs). Degraded mode (worker down) falls back to keyword snippets automatically.

---

### ADR-03: Webhook Secret Storage as AES-256-GCM Encrypted (Not bcrypt)

**Context:** HMAC-SHA256 requires the plaintext secret to compute signatures. bcrypt is one-way and cannot be reversed.

**Decision:** Webhook secrets are stored AES-256-GCM encrypted in `agents.webhook_secret_enc`. The encryption key (`DOCVAULT_AUTH_SECRET_KEY`) is a 32-byte random hex value stored in `.env`, never in the DB. IV and auth tag are stored alongside the ciphertext as `iv:tag:ciphertext` hex.

**Alternatives rejected:**
- Store plaintext secret: unacceptable; DB compromise exposes all webhook secrets.
- bcrypt hash + re-issue on each webhook: cannot verify signatures against a one-way hash.
- Separate key management service: overkill for a single-host deployment.

**Consequences:** Loss of `DOCVAULT_AUTH_SECRET_KEY` requires re-issuing all webhook secrets. Key rotation requires decrypting + re-encrypting all secrets. Document this in operational runbook.

---

### ADR-04: RRF (Reciprocal Rank Fusion) for Hybrid Search

**Context:** Combining pgvector cosine scores (continuous, range ~0–1) with tsvector BM25-like scores (discrete counts) requires score normalization. Direct score addition is unstable across query types.

**Decision:** Use RRF with configurable `k` (default 60). Both keyword and vector searches return ranked lists; RRF combines via `1/(k + rank)`. Implemented as a single SQL CTE — no application-layer merging.

```sql
WITH semantic AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $query_vec) AS rank
  FROM documents
  WHERE deleted_at IS NULL
  ORDER BY embedding <=> $query_vec
  LIMIT $limit * 2
),
keyword AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(tsvector_col, query) DESC) AS rank
  FROM documents, websearch_to_tsquery('english', $q) query
  WHERE tsvector_col @@ query AND deleted_at IS NULL
  LIMIT $limit * 2
),
fused AS (
  SELECT
    COALESCE(s.id, k.id) AS id,
    COALESCE(1.0/(60 + s.rank), 0) + COALESCE(1.0/(60 + k.rank), 0) AS score
  FROM semantic s FULL OUTER JOIN keyword k ON s.id = k.id
)
SELECT d.*, f.score FROM fused f
JOIN documents d ON d.id = f.id
ORDER BY f.score DESC
LIMIT $limit;
```

**Alternatives rejected:**
- Score normalization (min-max): requires knowing global score distributions, unstable for sparse queries.
- Single-mode only: degrades recall for different query types (structured vs. natural language).

---

### ADR-05: Anchor Lost Detection on Document Update

**Context:** When a document's content changes, comment `pos.start` / `pos.end` character offsets may no longer correspond to the same text.

**Decision:** On `PUT /api/v1/documents/:id`, after saving new content, Fastify runs:

```sql
UPDATE comments SET anchor_lost = true
WHERE doc_id = $1
  AND type = 'inline'
  AND selector IS NOT NULL
  AND (selector->'pos'->>'end')::int > length($new_content)
  AND deleted_at IS NULL;
```

This only catches truncation. For more precise invalidation, a text-diff approach would compare the exact quoted text (`selector.quote.exact`) against the new content using substring search. This is implemented in `src/api/routes/documents.ts` on PUT using JavaScript `String.prototype.includes()` — if `exact` is not found in the new content, `anchor_lost` is set.

**Alternatives rejected:**
- Re-anchor automatically using fuzzy matching: complex, error-prone, loses the ability to tell the human that a comment position changed.
- Invalidate all comments on any edit: too aggressive; discourages iteration.

---

### ADR-06: No Docker — Native Systemd Process Management

**Context:** Host constraint explicitly forbids Docker.

**Decision:** All services run as native processes managed by systemd. The Python worker runs in a virtualenv. Node runs the compiled Fastify app directly. Caddy is installed as a system package.

**Consequences:**
- Dependency isolation is weaker than containers: the system Python and Node versions must be managed carefully.
- GPU access is simpler (no device mapping).
- Deployment = `git pull && npm run build && systemctl restart docvault-api`.
- CUDA libraries must be compatible with the system driver; track driver version in repo docs.

---

### ADR-07: Content Excluded from List Responses by Default

**Context:** FR-API-00 mandates token-efficiency for agent consumers. Markdown content can be hundreds of kilobytes.

**Decision:** `GET /api/v1/documents` excludes the `content` field unless `?content=true` is passed. `null`/`false` fields are omitted unless `?nulls=true`. This is enforced in the route handler by destructuring the DB result and explicitly building the response object.

**Alternatives rejected:**
- GraphQL field selection: adds protocol complexity not warranted for this use case.
- Always include content: a list of 50 docs at 50KB average = 2.5MB response; unacceptable for agent contexts with token limits.

---

### ADR-08: HNSW Index Parameters (m=16, ef_construction=128)

**Context:** pgvector 0.8.x supports HNSW. The PRD requires ≥50k documents without rebuild and p95 search ≤200ms.

**Decision:** `m=16` (connections per node) and `ef_construction=128`. At query time, `ef_search=100` is the default (configurable per-request). At 50k documents with 768-dim vectors, the HNSW index is approximately 650MB in memory (50k × 16 neighbours × 768 dims × 4 bytes × ~1.3 overhead factor). This fits within the host's RAM budget.

**Runtime `ef_search`:** Set per-query via:
```sql
SET LOCAL hnsw.ef_search = $ef_search;
```
inside a transaction before executing the vector query.

**Alternatives rejected:**
- IVFFlat: requires `VACUUM ANALYZE` after bulk inserts to update list centroids; HNSW is insert-friendly.
- `m=32` / `ef_construction=256`: better recall but doubles index memory to ~1.3GB; unjustified at 50k docs.

---

*End of DocVault Technical Architecture Document.*
