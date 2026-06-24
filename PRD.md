# DocVault — Product Requirements Document

**Version:** 1.4 — APPROVED
**Author:** the Operator
**Date:** 2026-06-07
**Status:** Approved

---

## 1. Overview

AI agents operating on a personal Linux workstation produce a continuous stream of structured markdown artifacts — PRDs, research briefs, technical designs, architecture documents — that have no purpose-built home. Generic note tools (Obsidian, Notion) lack a machine-readable REST API suitable for agent consumption; vector databases lack a human-facing review and annotation layer; code repositories lack inline commenting tied to rendered document structure. DocVault is a self-hosted service that closes this gap: it stores markdown documents in PostgreSQL, exposes a Fastify REST API for agent CRUD operations, renders documents in a mobile-friendly web UI, and provides W3C-anchored inline commenting so a human reviewer can leave precise feedback that agents can read back and act on. A pgvector HNSW index over nomic-embed-text-v1.5 embeddings enables semantic retrieval, and a hybrid RRF ranking layer combines vector similarity with full-text tsvector search. The result is a private, single-user knowledge base where humans and agents collaborate on the same documents through their natural interfaces — a browser and an HTTP API — with no Docker, no cloud dependency, and no third-party data exposure.

---

## 2. Goals & Non-Goals

### Goals

- Provide a durable, queryable store for agent-generated markdown documents on a local Linux workstation.
- Enable a human reviewer to leave inline, text-selection-anchored comments on rendered markdown from a MacBook or mobile browser.
- Expose a complete, machine-readable REST API so Claude CLI agents can submit documents, retrieve comments, respond to feedback, and search the knowledge base without human mediation.
- Deliver hybrid semantic + keyword search with sub-200ms p95 latency over a corpus of up to 10,000 documents.
- Run entirely natively on Ubuntu 24.04 (Node 22, Python 3.12, PostgreSQL 16) with no Docker dependency.
- Secure the service with static bearer tokens (agents) and session auth (web UI) over a Tailscale network boundary.

### Non-Goals (v1)

- Multi-user or team collaboration (single-user system; the Operator is the only human).
- Real-time collaborative editing of documents.
- Document version diffing or merge conflict resolution.
- OAuth / SSO / LDAP authentication.
- Public internet exposure (Tailscale network boundary is mandatory).
- Native mobile app (responsive web UI suffices).
- Support for non-markdown document formats (PDF, DOCX, etc.).
- Fine-tuning or retraining the embedding model.
- Plugin or extension system.

---

## 3. Users

### Persona 1 — the Operator (Human Reviewer)

**Role:** the Operator
**Environment:** MacBook (primary review device), Android/iOS phone (ad-hoc review), Linux workstation (service host)
**Behavior:** The Operator does not initiate document creation. Agents submit documents; the Operator opens the web UI on the MacBook, reads the rendered markdown, selects text passages, and leaves inline comments or page-level notes. The Operator expects GitHub-quality markdown rendering, fast load times on a mobile connection, and a comment UI that does not require a mouse (touch selection must work). The Operator occasionally flags a comment as "promote to memory" via a UI button, expecting the system to trigger `memory-tool` in the background and confirm success.
**Technical comfort:** High. The Operator will read API docs, inspect raw JSON responses, and tolerate zero hand-holding in the UI.

### Persona 2 — Claude CLI Agent (API Consumer)

**Role:** Automated agent running Claude Code or a custom agent harness on the Linux workstation
**Environment:** Node 22 / Python 3.12 process; communicates via HTTP; authenticated with a static bearer token stored in the agent's environment or `.claude/settings.json`.
**Behavior:** Agents POST new documents after completing a research or design task. They poll or receive webhook callbacks when the Operator has added comments. They GET structured comment data (with exact text anchors), interpret the feedback, revise the document, and PUT an updated version. Agents also issue semantic and keyword search requests to find prior documents relevant to a new task. Agents never touch the web UI.
**Contract requirement:** All agent interactions must be fully machine-readable JSON with stable field names and versioned API paths. Breaking changes require a major version bump.

---

## 4. Functional Requirements

### 4.1 Document Management

**FR-DOC-01** The system shall accept document submissions via `POST /api/v1/documents` with the following required fields: `title` (string), `content` (markdown string), `type` (enum: `prd` | `research` | `design` | `architecture` | `notes`), `project` (string, free-form slug). Optional fields: `tags` (string array), `agent_id` (string identifying the submitting agent), `metadata` (JSONB freeform).

**FR-DOC-02** Each document shall be assigned a stable UUID on creation, returned in the `201` response as `document_id`.

**FR-DOC-03** The system shall store the raw markdown source alongside the rendered HTML. The remark → rehype pipeline shall inject stable `data-block-id` attributes on every block-level element (paragraph, heading, list item, code block, blockquote) deterministically derived from block index and content hash to support comment anchoring.

**FR-DOC-04** The system shall support `GET /api/v1/documents` with query parameters: `type`, `project`, `tags` (multi-value), `after` (ISO 8601 date), `before` (ISO 8601 date), `limit` (default 20, max 100), `offset`. Response includes document metadata but not full content by default; pass `?include_content=true` to include the markdown body.

**FR-DOC-05** `GET /api/v1/documents/:id` shall return full document metadata, rendered HTML, raw markdown, comment count, and embedding status (`pending` | `ready` | `failed`).

**FR-DOC-06** `PUT /api/v1/documents/:id` shall replace document content, increment a `version` integer field, re-trigger the embedding pipeline, and preserve all existing comments with their original anchors. If anchor text no longer exists in the new version, the comment status shall be set to `anchor_lost` rather than deleted.

**FR-DOC-07** `DELETE /api/v1/documents/:id` shall soft-delete the document (set `deleted_at` timestamp), remove it from search indexes, and return `204`. Hard deletion is not exposed in v1.

**FR-DOC-08** The system shall track `created_at`, `updated_at`, `deleted_at`, `version` (integer starting at 1), `author_agent_id`, and `word_count` on every document.

---

### 4.2 Commenting

**FR-CMT-01** Comments shall be createable via `POST /api/v1/documents/:id/comments`. Required fields: `body` (string, markdown-formatted), `author` (string; `"reviewer"` for human, agent ID string for agents), `type` (enum: `inline` | `page`). For `inline` comments, `selector` is also required (see FR-CMT-02).

**FR-CMT-02** Inline comment selectors shall conform to the W3C Web Annotation Data Model. Each selector object shall contain both a `TextQuoteSelector` (with `exact`, `prefix`, `suffix` strings) and a `TextPositionSelector` (with `start` and `end` character offsets relative to the rendered document text). Both selectors shall be stored as JSONB. This dual-selector approach enables re-anchoring if character offsets shift on document update.

**FR-CMT-03** The system shall use `recogito/text-annotator-js` (MIT) in the web UI for text-selection-triggered comment creation. Selection of any text range in the rendered document shall display a comment popover anchored to the selection.

**FR-CMT-04** Comments shall support threading: any comment may have a `parent_comment_id` field. Replies form a two-level flat thread (top-level comment + N replies). Threads deeper than two levels are not required in v1.

**FR-CMT-05** Each comment shall record: `id` (UUID), `doc` (document UUID), `parent` (parent comment UUID, nullable), `author` (string), `type` (`inline` | `page`), `body` (string), `selector` (JSONB, nullable for page-level), `round` (integer, default 1), `resolved` (boolean, default false), `created` (timestamp), `updated` (timestamp).

**FR-CMT-06** `GET /api/v1/documents/:id/comments` shall return all non-deleted comments grouped by thread, ordered by `created_at` ascending. Comments with `anchor_lost` status shall be included with a flag; clients decide whether to display them.

**FR-CMT-07** `PATCH /api/v1/comments/:id` shall allow updating `body` and `resolved`. `author`, `selector`, `doc`, and `type` are immutable after creation.

**FR-CMT-08** `DELETE /api/v1/comments/:id` shall soft-delete the comment. Soft-deleted parent comments shall be replaced with a tombstone (`[deleted]` body) if replies exist.

**FR-CMT-09** The web UI shall visually highlight all anchored inline comment ranges in the rendered document with color-coded underlines. Clicking a highlighted range shall open the comment thread in a side panel without navigating away from the document.

**FR-CMT-10** The system shall record a `commented_at` timestamp on the parent document whenever any comment is created or updated, enabling agents to efficiently poll for documents that have received new feedback.

---

### 4.3 Search

**FR-SRCH-01** The system shall index every document's `content` field using a PostgreSQL `tsvector` with `english` dictionary for full-text keyword search.

**FR-SRCH-02** The system shall generate embeddings for every document using `nomic-embed-text-v1.5` via `sentence-transformers` (Python 3.12 worker, RTX 3050 GPU). Embeddings shall be stored in a `pgvector` column with an HNSW index (`lists=100`, `ef_construction=200`, `m=16` as starting defaults, tunable via config).

**FR-SRCH-03** Embedding generation shall be asynchronous, queued via `pg-boss`, and must not block the document submission response. Documents with `embedding_status = pending` are still queryable via keyword search.

**FR-SRCH-04** The search endpoint `POST /api/v1/search` shall accept: `query` (string), `mode` (enum: `semantic` | `keyword` | `hybrid`, default `hybrid`), `type` (optional filter), `project` (optional filter), `tags` (optional multi-value filter), `after` / `before` (optional date filters), `limit` (default 10, max 50).

**FR-SRCH-05** Hybrid search shall use Reciprocal Rank Fusion (RRF) with `k=60` as the default constant to merge semantic and keyword result lists. The `rrf_k` parameter shall be tunable per request for experimentation.

**FR-SRCH-06** Search results shall return: `id`, `title`, `type`, `project`, `snippet` (120-char excerpt), `score`, `created`, `comments`. Snippet generation strategy: for keyword and hybrid results, extract the sentence containing the strongest keyword match. For pure semantic results, select the sentence from the document with the highest cosine similarity to the query embedding, computed using the already-warm `nomic-embed-text-v1.5` model on the RTX 3050 (no additional API calls or tokens consumed). Sentence-level embedding adds ≤50ms latency on GPU at typical document lengths.

**FR-SRCH-07** Semantic search shall use cosine distance (`<=>` operator) with the HNSW index. The `ef_search` parameter shall be configurable (default 100).

**FR-SRCH-08** Search shall exclude soft-deleted documents. Documents with `embedding_status = pending` shall appear in keyword results only until embedding completes.

---

### 4.4 Agent API

**FR-API-00 — Response Design Principles (token efficiency)**
All API responses shall be designed to minimise token consumption for LLM agents parsing them. Rules:

- **Short field names:** `id`, `doc`, `created`, `updated`, `status`, `words`, `comments`, `indexed` — not `document_id`, `document_uuid`, `created_at`, `word_count`, `comment_count`, `embedding_status`
- **No envelope wrappers:** respond with `{ "docs": [...], "next": "cursor", "total": N }` not `{ "data": { "documents": { "items": [...] } } }`
- **Omit null and false fields by default:** a comment with `resolved: false` and no `parent` shall omit both fields; opt-in via `?nulls=true`
- **Content excluded from list responses:** markdown body and rendered HTML are never returned in list or search responses; only returned on `GET /docs/:id` or when `?content=true` is explicitly passed
- **Selector schema uses short keys:** `quote` (not `TextQuoteSelector`), `pos` (not `TextPositionSelector`), `pre`/`post` (not `prefix`/`suffix`)
- **Timestamps as ISO 8601 strings**, not epoch integers
- **Errors as flat objects:** `{ "status": 401, "error": "missing_token", "detail": "Authorization header required" }` — no RFC 7807 verbosity
- **Pagination:** `next` cursor string at top level, not nested in a `meta` or `pagination` object
- **Enums as short lowercase strings** matching the field values defined in this PRD
- **Snippets capped at 120 chars** in search results

Example document list item (target shape):
```json
{
  "id": "a1b2c3",
  "title": "DocVault PRD",
  "type": "prd",
  "project": "docvault",
  "status": "in_review",
  "version": 2,
  "words": 3420,
  "comments": 5,
  "indexed": true,
  "created": "2026-06-07T18:00:00Z",
  "updated": "2026-06-07T19:00:00Z"
}
```

Example inline comment (target shape):
```json
{
  "id": "d4e5f6",
  "doc": "a1b2c3",
  "author": "agent-researcher",
  "type": "inline",
  "body": "This assumption needs a citation.",
  "selector": {
    "quote": { "exact": "selected text", "pre": "before ", "post": " after" },
    "pos": { "start": 1420, "end": 1439 }
  },
  "round": 1,
  "created": "2026-06-07T18:30:00Z"
}
```

**FR-API-01** All agent-facing endpoints shall be under `/api/v1/`. The API version shall be included in the path to allow future breaking changes under `/api/v2/`.

**FR-API-02** All responses shall be `application/json`. Errors shall use a flat three-field shape: `{ "status": <http_code>, "error": "<machine_code>", "detail": "<human readable>" }`. Machine error codes shall be stable snake_case strings (e.g. `missing_token`, `doc_not_found`, `invalid_selector`) suitable for programmatic handling by agents without string parsing.

**FR-API-03** Agent authentication shall use static bearer tokens passed as `Authorization: Bearer <token>` headers. Tokens are stored as bcrypt hashes in the database. Multiple tokens may be active simultaneously (one per agent identity). Token provisioning is done via a CLI admin command, not via an API endpoint in v1.

**FR-API-04** `GET /api/v1/documents?commented_after=<ISO8601>` shall allow agents to poll for documents that have received new or updated comments since a given timestamp, enabling a polling-based feedback loop without a persistent connection.

**FR-API-05** The comment response schema for agent consumption shall include the full `selector` JSONB (both `TextQuoteSelector` and `TextPositionSelector`), enabling agents to locate the exact passage under discussion in the markdown source without rendering the document.

**FR-API-06** The system shall support outbound webhooks. `PATCH /api/v1/agents/:agent_id/webhook` registers a URL and generates a per-agent HMAC-SHA256 signing secret. Each webhook POST shall include an `X-DocVault-Signature: sha256=<hmac>` header computed over the raw request body using that agent's secret. Receiving agents verify the signature before trusting the payload. The signing secret is shown once at registration time (like a bearer token) and stored only as a hash. Payload: `{ "event": "comment.created", "doc": "<id>", "comment": "<id>", "ts": "<iso8601>" }`. Delivery retries up to 3 times with exponential backoff (1s, 4s, 16s). Failures are logged but do not raise application errors.

**FR-API-07** `GET /api/v1/documents/:id/comments?unread_by=<agent_id>` shall return only comments not yet acknowledged by the specified agent. `POST /api/v1/documents/:id/comments/:comment_id/ack?agent_id=<agent_id>` shall mark a comment as read by that agent.

**FR-API-08** The API shall return stable, documented pagination cursors (`next_cursor` field) in list responses as an alternative to offset pagination for large result sets.

**FR-API-09** `GET /api/v1/health` shall return `{ status: "ok", db: "ok", embeddings: "ok"|"degraded", queue_depth: <int> }` without authentication.

---

### 4.5 Web UI

**FR-UI-01** The web UI shall be a server-rendered or lightweight SPA (no heavy framework requirement, but must be mobile-functional) served by the Fastify process on the same port.

**FR-UI-02** Markdown shall be rendered using the same remark → rehype pipeline used for storage, ensuring `data-block-id` attributes are present and consistent between stored HTML and what is displayed.

**FR-UI-03** The document list view shall display: title, type badge, project, creation date, word count, comment count, and embedding status indicator. List shall be sortable by creation date and title, and filterable by type and project via UI controls.

**FR-UI-04** The document detail view shall render markdown with syntax-highlighted code blocks (highlight.js or Prism), and shall load all comment annotations via `recogito/text-annotator-js` so that commented passages are highlighted on initial load.

**FR-UI-05** The comment side panel shall be togglable and shall display threads sorted by document position (top-to-bottom). Each thread shall show the anchor text quoted in a blockquote style, the comment body, author, round number, timestamp, and resolved status.

**FR-UI-06** The Operator shall be able to resolve a comment thread directly from the side panel with a single click, without navigating to a separate page.

**FR-UI-07** The web UI shall be functional on mobile (375px minimum viewport width). Touch-based text selection shall be attempted via `recogito/text-annotator-js`. If touch selection is unavailable or unreliable on the current device/browser, a fallback mode shall activate: tapping anywhere within a rendered block (paragraph, heading, list item, code block) opens the comment composer anchored to that block's `data-block-id`, with the full block text as the `quote.exact` selector value.

**FR-UI-08** The web UI shall support a dark mode, togglable via a UI control, with preference persisted in `localStorage`.

**FR-UI-09** The document list shall support basic full-text search via a search input that calls the `/api/v1/search` endpoint in hybrid mode and updates results in real time (debounced 300ms).

**FR-UI-10** The web UI shall provide a raw markdown view (toggle) for any document, allowing the Operator to inspect or copy the source.

---

### 4.7 Agent Review Coordination

**FR-REV-01** The system shall support assigning a document to one or more reviewer agents via `POST /api/v1/documents/:id/reviews`. Required fields: `reviewers` (array of agent ID strings), `notify_on_complete` (agent ID string or webhook URL to notify when all reviews are finished). Optional: `instructions` (string — task description passed to each reviewer agent), `deadline` (ISO 8601 datetime).

**FR-REV-02** Each review assignment shall be tracked in a `reviews` table with fields: `review_id` (UUID), `document_id`, `agent_id`, `status` (enum: `pending` | `in_progress` | `complete` | `skipped`), `instructions` (string, nullable), `deadline` (timestamp, nullable), `assigned_at`, `started_at` (nullable), `completed_at` (nullable).

**FR-REV-03** `GET /api/v1/documents/:id/reviews` shall return the full review roster: each reviewer's agent ID, status, assigned_at, completed_at, and comment count authored by that agent on this document.

**FR-REV-04** A reviewer agent shall signal the start of review via `PATCH /api/v1/documents/:id/reviews/:agent_id` with `{ "status": "in_progress" }`. It shall signal completion via the same endpoint with `{ "status": "complete" }`. No other service or human action is required to advance these states.

**FR-REV-05** When all assigned reviewers for a document have reached `complete` or `skipped` status, the system shall automatically trigger the `notify_on_complete` action: if the value is an agent ID with a registered webhook, fire the webhook; if it is a direct webhook URL, POST to it. Payload: `{ "event": "review.complete", "document_id", "review_summary": { "total": N, "complete": N, "comment_count": N } }`.

**FR-REV-06** `GET /api/v1/documents/:id/comments?group_by=author` shall return comments organised by `author` agent ID, enabling a synthesiser agent to read each reviewer's perspective as a distinct block rather than a flat chronological list.

**FR-REV-07** Documents shall gain a `workflow_status` field (enum: `draft` | `in_review` | `synthesizing` | `final`). The system shall automatically transition `draft → in_review` when a review assignment is created, and `in_review → synthesizing` when all reviews are complete. Transitions to `synthesizing → final` are set explicitly by the synthesiser agent via `PATCH /api/v1/documents/:id` with `{ "workflow_status": "final" }`.

**FR-REV-08** The system shall support review rounds. Each review assignment shall carry a `round` integer (default 1). When a synthesiser agent PUTs a revised document and creates a new review assignment, it may pass `round: 2` to distinguish second-pass reviewer comments from first-pass. `GET /api/v1/documents/:id/comments?round=1` shall filter by round.

**FR-REV-09** `GET /api/v1/documents?workflow_status=in_review` and `?workflow_status=synthesizing` shall allow orchestrator agents to query documents currently awaiting action, enabling pipeline monitoring without webhooks.

**FR-REV-10** If a `deadline` is set on a review assignment and the reviewer has not reached `complete` by that time, the system shall automatically transition the assignment to `skipped`, log a warning, and proceed with the `notify_on_complete` trigger (so a missed reviewer does not stall the pipeline indefinitely).

---

### 4.6 Auth & Access

**FR-AUTH-01** The Fastify server shall be bound to `127.0.0.1` (loopback) only. All external access shall route through Caddy as a reverse proxy, which handles HTTPS termination and certificate management (Caddy automatic HTTPS).

**FR-AUTH-02** Caddy shall be configured to accept connections only from the Tailscale interface (`100.x.x.x/8` CIDR range). Direct internet access is not supported and is not a requirement.

**FR-AUTH-03** Agent API routes (`/api/v1/*`) shall require a valid `Authorization: Bearer <token>` header on every request. Missing or invalid tokens return `401`. No token expiry in v1; tokens are revoked by deletion from the database.

**FR-AUTH-04** Web UI routes shall use session-based authentication with a session cookie (HttpOnly, Secure, SameSite=Strict). Session tokens shall be stored in PostgreSQL (not in-memory) to survive process restarts. Session duration shall default to 7 days with sliding expiration.

**FR-AUTH-05** The Operator shall authenticate to the web UI via a username/password login form. Credentials shall be stored as bcrypt hashes. There is exactly one web UI user account in v1; multi-user support is out of scope. The initial password and any subsequent password changes shall be set exclusively via the CLI command `docvault admin user set-password`, never via the web UI or API.

**FR-AUTH-06** A CLI admin command (`docvault admin token create --name <label>`) shall be the only mechanism for issuing new bearer tokens. The plaintext token is shown once at creation time and never stored; only the bcrypt hash is persisted.

**FR-AUTH-07** All API requests shall be logged with: timestamp, method, path, response status, agent token ID (redacted), and latency. Logs shall be written to a rotating file and to stdout in JSON Lines format.

---

## 5. Non-Functional Requirements

**NFR-PERF-01** `GET /api/v1/documents/:id` (without search) shall respond at p95 ≤ 50ms under a single-user load on the target hardware.

**NFR-PERF-02** Hybrid search `POST /api/v1/search` shall respond at p95 ≤ 200ms for a corpus of up to 10,000 documents with HNSW index fully loaded.

**NFR-PERF-03** Document submission (`POST /api/v1/documents`) shall respond at p95 ≤ 100ms. Embedding generation is asynchronous and shall not be included in this target.

**NFR-PERF-04** Embedding throughput on the RTX 3050 (6GB) using `nomic-embed-text-v1.5` shall sustain ≥ 50 documents/minute for documents up to 4,000 tokens. The Python worker shall batch embeddings in groups of 16 by default.

**NFR-PERF-05** The web UI initial page load (document list) shall achieve a Time to Interactive ≤ 2s on a 10 Mbps connection.

**NFR-REL-01** The application shall survive PostgreSQL restart without data loss. In-flight embedding jobs interrupted by restart shall be re-queued automatically on startup (pg-boss handles this via the `jobs` table).

**NFR-REL-02** The embedding Python worker shall be managed by `systemd` with `Restart=on-failure` and a maximum restart burst of 5 in 60 seconds, after which it alerts via a log entry and pauses for 5 minutes.

**NFR-REL-03** The Fastify API server shall be managed by `systemd` with `Restart=on-failure`. It shall start successfully even if the Python embedding worker is unavailable (degraded mode: embeddings queued, not processed).

**NFR-SEC-01** All secrets (database credentials, bearer token hashes, session secret) shall be loaded from environment variables or a `.env` file with `chmod 600`. They shall not appear in source code, logs, or error responses.

**NFR-SEC-02** All database queries shall use parameterized statements via Drizzle ORM. Raw SQL interpolation of user input is prohibited.

**NFR-SEC-03** Markdown rendering shall sanitize output (DOMPurify or equivalent) to prevent stored XSS via document content. Agent-submitted markdown is untrusted input.

**NFR-SEC-04** The `memory-tool` CLI invocation shall not use shell interpolation of comment body text. Arguments shall be passed as an array to `child_process.spawn` (Node) or `subprocess.run` (Python) to prevent command injection.

**NFR-SCALE-01** The schema and HNSW index configuration shall support up to 50,000 documents without index rebuild. Validated via `pgvector` HNSW capacity guidelines.

**NFR-SCALE-02** The system is explicitly single-user and single-workstation. Horizontal scaling is out of scope. Vertical scaling (more RAM, GPU upgrade) is the expected scaling path.

**NFR-OPS-01** A `docvault backup` CLI command shall dump the PostgreSQL database (using `pg_dump`) to a timestamped `.sql.gz` file in a configurable backup directory. This command shall be runnable as a cron job.

**NFR-OPS-02** Application configuration shall be centralized in a single TOML or YAML config file, with all values overridable by environment variables using a documented naming convention (`DOCVAULT_<SECTION>_<KEY>`).

---

## 6. User Stories

**US-01 — Agent submits a new PRD**
As a Claude CLI agent, I want to POST a completed PRD in markdown to DocVault so that the Operator can review it and I can retrieve structured feedback without managing files manually.

**US-02 — The Operator reviews and annotates a document on mobile**
As the Operator, I want to select a text passage in a rendered PRD on my phone and leave an inline comment so that the agent knows precisely which claim or section needs revision.

**US-03 — Agent polls for new comments**
As a Claude CLI agent, I want to query for documents that have received new comments since my last check so that I can retrieve feedback and begin a revision pass without requiring a persistent connection.

**US-04 — Agent retrieves structured comment anchors**
As a Claude CLI agent, I want to receive comment data including `TextQuoteSelector` with `exact`, `prefix`, and `suffix` fields so that I can locate the specific passage under discussion in the markdown source without rendering the document.

**US-05 — The Operator searches prior research**
As the Operator, I want to type a natural-language query in the search bar and get semantically relevant documents ranked above lexically similar but topically unrelated ones so that I can find relevant prior work even when I don't remember the exact wording.

**US-06 — The Operator promotes a comment to agent memory**
As the Operator, I want to click a "Promote to Memory" button on a high-signal comment so that the `memory-tool` CLI stores the insight in the agent's long-term memory and I can verify it succeeded via a status indicator.

**US-07 — Agent submits a revised document**
As a Claude CLI agent, I want to PUT an updated version of a document after addressing review comments so that the revision is versioned, the original comments are preserved with their anchors, and the Operator is implicitly notified that a new version is available.

**US-08 — The Operator resolves a comment thread**
As the Operator, I want to mark a comment thread as resolved from the side panel after verifying the agent addressed it so that the document's unresolved comment count reflects the true outstanding review workload.

**US-09 — Agent receives a webhook on new comment**
As a Claude CLI agent, I want to register a webhook URL so that DocVault sends me an HTTP notification when the Operator leaves a comment, enabling me to begin revision immediately rather than polling on a fixed schedule.

**US-10 — The Operator browses documents by project**
As the Operator, I want to filter the document list by project slug and sort by creation date so that I can quickly see all artifacts for the project I'm currently focused on without wading through unrelated documents.

**US-11 — Author agent orchestrates a multi-agent review**
As a Claude CLI agent that has produced a design document, I want to assign three specialist reviewer agents (researcher, architect, security) and nominate a synthesiser agent to be notified when all reviews are complete, so that the review pipeline runs autonomously without me polling for completion.

**US-12 — Synthesiser agent consumes grouped review feedback**
As a synthesiser agent, I want to retrieve comments on a document grouped by reviewer agent ID so that I can assess each reviewer's perspective independently before producing a consolidated revision, rather than processing an undifferentiated flat list of comments.

---

## 7. Acceptance Criteria

**AC-01 — End-to-end agent feedback loop**
Given an agent POSTs a document and the Operator adds an inline comment via the web UI, when the agent GETs `/api/v1/documents/:id/comments`, then the response includes a comment object with a `selector.TextQuoteSelector.exact` field containing the exact selected text, within 5 seconds of the Operator submitting the comment.

**AC-02 — Hybrid search relevance**
Given a corpus of 100+ documents with 10 documents semantically related to the query "vector database performance tuning" but not containing those exact words, when a hybrid search is issued for "speeding up embedding retrieval," then at least 4 of the 10 semantically related documents appear in the top 10 results.

**AC-03 — Comment anchor persistence across document update**
Given an inline comment with a valid `TextQuoteSelector` exists on version 1 of a document, when the agent PUTs a new version that preserves the commented passage, then the comment's `anchor_lost` field remains `false` and the highlighted passage renders correctly in the web UI.

**AC-04 — Memory promotion end-to-end**
Given the Operator flags a comment with `memory_flagged: true`, when the `memory-tool` CLI exits with code `0`, then the comment's `memory_status` transitions to `synced` and the web UI displays a success indicator within 10 seconds of flag creation, without a page reload.

**AC-05 — Auth enforcement**
Given a request to any `/api/v1/*` endpoint without an `Authorization` header, the server returns HTTP `401` with a RFC 7807 `application/problem+json` response body, and the request does not appear in the application data log (only the access log).

**AC-07 — Multi-agent review pipeline completes autonomously**
Given an author agent POSTs a document and creates a review assignment for three reviewer agents with a synthesiser nominated via `notify_on_complete`, when all three reviewer agents POST comments and PATCH their status to `complete`, then the synthesiser's webhook fires exactly once with `event: "review.complete"` and the document's `workflow_status` transitions to `synthesizing` — with no human or orchestrator intervention required.

**AC-06 — Service resilience on embedding worker failure**
Given the Python embedding worker process is killed (SIGKILL), when an agent POSTs a new document, then the API returns `201` with `embedding_status: "pending"`, the document is retrievable via keyword search immediately, and when the worker process is restarted the embedding job is picked up and completed without manual intervention.

---

## 8. Out of Scope (v1)

- **Multi-user support:** No team sharing, role-based access control, or per-user comment visibility. Single owner only.
- **Document editing via UI:** The web UI is read-and-comment-only. All document creation and updates are via the agent API.
- **Version diffing:** Document version history is stored (version integer + `updated_at`), but no diff view between versions is built.
- **Comment export:** No bulk export of comments to external formats (JSON dump, CSV). The API provides all data; a purpose-built export feature is not included.
- **Non-markdown formats:** PDF, DOCX, HTML upload, and plain-text ingestion are not supported. Markdown only.
- **Embedding model fine-tuning or swapping at runtime:** The model is fixed to `nomic-embed-text-v1.5` and requires a config change + reindex to change.
- **Full re-indexing UI:** Re-indexing all documents after an embedding model change is a CLI admin command only, not a UI workflow.
- **Comment notifications via email or push:** Feedback delivery to the Operator is in-browser only. No email, no push notifications.
- **Audit log UI:** Access logs are written to disk; no in-app audit log viewer.
- **Containerization:** Docker, Podman, and container orchestration are explicitly excluded.
- **Cloud sync or backup to remote storage:** `docvault backup` writes to local disk only.
- **Memory-tool / agent memory integration:** Comment-to-memory promotion is deferred to a future version. Comments have no `memory_flagged` field in v1.

---

## 9. Open Questions

**OQ-01 — RESOLVED:** `docvault admin user set-password` CLI flow confirmed. See FR-AUTH-05.

**OQ-02 — RESOLVED:** `anchor_lost` warning approach confirmed. No automated re-anchoring in v1. When a document update invalidates a `TextPositionSelector` offset, the comment is marked `anchor_lost: true` and surfaced as a warning in the UI. The `TextQuoteSelector.exact` text is still stored and visible, giving the Operator and agents context on what was commented. Automated fuzzy re-anchoring deferred to v2.

**OQ-03 — RESOLVED:** Per-agent HMAC-SHA256 signing secrets confirmed. See FR-API-06.

**OQ-05 — RESOLVED:** Store `embedding_model_version` per document. Enables partial re-index on model change and filters search to current-model docs during migration. Adds a single `TEXT` column. See schema in architecture doc.

**OQ-06 — RESOLVED:** No TTL. Rate-limited consumer, `batch_size=16` docs per pg-boss job poll. All queued jobs processed on worker recovery. Silent data loss from TTL is worse than a brief catch-up burst at this scale.

**OQ-07 — RESOLVED:** Sentence-level semantic snippet on local GPU confirmed. See FR-SRCH-06.

**OQ-08 — RESOLVED:** Block-level tap fallback confirmed. See FR-UI-07.
