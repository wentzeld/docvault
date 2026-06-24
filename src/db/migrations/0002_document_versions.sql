-- 0002_document_versions.sql
-- Append-only snapshot table — one row per past version of a document.
-- created_at is set to the document's updated_at at time of snapshot,
-- so it records when that version was last live (not when it was archived).

CREATE TABLE IF NOT EXISTS document_versions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id      uuid        NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version     integer     NOT NULL,
  title       text        NOT NULL,
  content     text        NOT NULL,
  words       integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL,
  author      text
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc_version
  ON document_versions (doc_id, version DESC);
