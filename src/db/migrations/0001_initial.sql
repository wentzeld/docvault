-- DocVault initial migration — complete, self-contained
-- Creates all enums, tables, indexes, triggers, and vector column.
-- Idempotent — safe to re-run.

-- ── Extensions ────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE doc_type AS ENUM ('prd', 'research', 'design', 'architecture', 'notes');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE workflow_status AS ENUM ('draft', 'in_review', 'synthesizing', 'final');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE embed_status AS ENUM ('pending', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE comment_type AS ENUM ('inline', 'page');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE review_status AS ENUM ('pending', 'in_progress', 'complete', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── users ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  username        TEXT PRIMARY KEY,
  password_hash   TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── agents ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
  id                    TEXT PRIMARY KEY,
  webhook_url           TEXT,
  webhook_secret_enc    TEXT,
  webhook_events        TEXT[] NOT NULL DEFAULT '{}',
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── sessions ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_username    ON sessions (username);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at  ON sessions (expires_at);

-- ── tokens ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  hash          TEXT NOT NULL,
  lookup_hash   TEXT NOT NULL UNIQUE,
  agent_id      TEXT NOT NULL,
  scopes        TEXT[] NOT NULL DEFAULT '{read,write}',
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_agent_id  ON tokens (agent_id);
CREATE INDEX IF NOT EXISTS idx_tokens_revoked   ON tokens (revoked);

-- ── documents ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS documents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  type             doc_type NOT NULL,
  project          TEXT NOT NULL,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  agent_id         TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}',
  version          INTEGER NOT NULL DEFAULT 1,
  words            INTEGER NOT NULL DEFAULT 0,
  workflow_status  workflow_status NOT NULL DEFAULT 'draft',
  embed_status     embed_status NOT NULL DEFAULT 'pending',
  embed_model      TEXT,
  tsvector_col     TSVECTOR,
  commented_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);

-- Add vector column if not present (pgvector type — not expressible in Drizzle schema)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE documents ADD COLUMN embedding vector(768);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_project        ON documents (project);
CREATE INDEX IF NOT EXISTS idx_documents_type           ON documents (type);
CREATE INDEX IF NOT EXISTS idx_documents_embed_status   ON documents (embed_status);
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at     ON documents (deleted_at);
CREATE INDEX IF NOT EXISTS idx_documents_created_at     ON documents (created_at);
CREATE INDEX IF NOT EXISTS idx_documents_project_type   ON documents (project, type);
CREATE INDEX IF NOT EXISTS idx_documents_workflow_status ON documents (workflow_status);

CREATE INDEX IF NOT EXISTS idx_documents_tags ON documents USING gin (tags);

-- HNSW vector index (cosine similarity)
CREATE INDEX IF NOT EXISTS idx_documents_embedding_hnsw
  ON documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- GIN full-text index
CREATE INDEX IF NOT EXISTS idx_documents_tsvector_gin
  ON documents USING gin (tsvector_col);

-- Composite partial indexes
CREATE INDEX IF NOT EXISTS idx_documents_project_created
  ON documents (project, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_type_project
  ON documents (type, project, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_pending_embed
  ON documents (created_at ASC)
  WHERE embed_status = 'pending' AND deleted_at IS NULL;

-- tsvector auto-update trigger
CREATE OR REPLACE FUNCTION documents_tsvector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.tsvector_col :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.content, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_tsvector_update ON documents;
CREATE TRIGGER documents_tsvector_update
  BEFORE INSERT OR UPDATE OF title, content
  ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_tsvector_trigger();

-- Backfill existing rows
UPDATE documents
SET tsvector_col =
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(content, '')), 'B')
WHERE tsvector_col IS NULL;

-- ── comments ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_id    UUID REFERENCES comments(id),
  author       TEXT NOT NULL,
  type         comment_type NOT NULL DEFAULT 'page',
  body         TEXT NOT NULL,
  selector     JSONB,
  round        INTEGER NOT NULL DEFAULT 1,
  resolved     BOOLEAN NOT NULL DEFAULT FALSE,
  anchor_lost  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comments_doc_id      ON comments (doc_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id   ON comments (parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_author      ON comments (author);
CREATE INDEX IF NOT EXISTS idx_comments_doc_round   ON comments (doc_id, round);
CREATE INDEX IF NOT EXISTS idx_comments_resolved    ON comments (doc_id, resolved);
CREATE INDEX IF NOT EXISTS idx_comments_doc_created ON comments (doc_id, created_at ASC)
  WHERE deleted_at IS NULL;

-- ── comment_reads ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS comment_reads (
  comment_id  UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,
  read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (comment_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_reads_agent ON comment_reads (agent_id);

-- ── reviews ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  reviewer      TEXT NOT NULL,
  status        review_status NOT NULL DEFAULT 'pending',
  round         INTEGER NOT NULL DEFAULT 1,
  instructions  TEXT,
  deadline      TIMESTAMPTZ,
  notify_agent  TEXT,
  notify_url    TEXT,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (doc_id, reviewer, round)
);

CREATE INDEX IF NOT EXISTS idx_reviews_doc_status      ON reviews (doc_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_deadline        ON reviews (deadline);
CREATE INDEX IF NOT EXISTS idx_reviews_pending_deadline
  ON reviews (deadline ASC)
  WHERE status IN ('pending', 'in_progress') AND deadline IS NOT NULL;
