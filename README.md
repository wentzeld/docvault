# DocVault

A self-hosted document knowledge base for AI agents and humans. Store PRDs, research briefs, architecture docs, and design docs. Agents write; humans review, approve, and comment.

# Why

I built DocVault (with Claude) because I wanted an easier way to review and give feedback on the markdown docs produced by my bots. Working directly in Claude Code is a great experience, running a number of bots on say Telegram is more difficult, especially when it comes to quickly reviewing, giving feedback and sharing docs between bots and their agents. I installed Tailscale and now it is pretty easy to review docs on the go.

My setup at home is an old dell running Ubuntu and I bought a cheap 6GB Nvidia GPU, which I'm putting to work here on embeddings and faster search.

**Stack:** Node.js 22 (Fastify API) · PostgreSQL 16 + pgvector · Python embedding worker (nomic-embed-text-v1.5, GPU or CPU) · React UI · Caddy reverse proxy · Tailscale for private access.

---

## Quick start with Docker

The fastest way to try DocVault, and the recommended path on any OS (Linux,
macOS, Windows). This is a **CPU-only** quickstart — Postgres (with pgvector)
is included, so you don't need to install anything besides Docker.

```bash
# 1. Create your .env and set a secret key
cp .env.example .env
# Generate a 32-byte hex secret and set it as DOCVAULT_AUTH_SECRET_KEY:
openssl rand -hex 32   # paste the output into .env as DOCVAULT_AUTH_SECRET_KEY=...

# 2. Build and start everything (db + api + worker)
docker compose up --build

# 3. Open the UI
#    http://localhost:3000
```

Database migrations and the required `vector` / `pg_trgm` extensions are applied
automatically when the API container starts. The embedding model is downloaded
on first run and cached in a named volume.

> Embedding runs on CPU in this setup (slower indexing, but all search features
> work). For GPU acceleration and a production deployment, see the full install
> below.

---

## Table of Contents

1. [Install & Build](#1-install--build)
2. [Verify It's Running](#2-verify-its-running)
3. [Users, Bots & API Keys](#3-users-bots--api-keys)
4. [Connecting Bots to DocVault](#4-connecting-bots-to-docvault)
5. [Using the Web UI](#5-using-the-web-ui)
6. [Accessing DocVault on Mobile via Tailscale](#6-accessing-docvault-on-mobile-via-tailscale)
7. [Backups](#7-backups)
8. [Maintenance](#8-maintenance)

---

## 1. Install & Build

> This bare-metal path is **Ubuntu-specific** — `scripts/install.sh` uses `apt`
> and installs PostgreSQL/Caddy as system packages. On macOS, Windows, or any
> non-Ubuntu Linux, use the [Docker quickstart](#quick-start-with-docker) above
> instead. Choose this path only for a GPU-accelerated or systemd-managed
> production deployment on Ubuntu.

**Prerequisites:**
- Ubuntu 24.04
- Tailscale installed and connected (`tailscale up`)
- Node.js 22 (installed automatically if missing)
- **GPU (optional):** Pre-create `~/ml-env` with PyTorch+CUDA for faster embedding. If absent, the install script creates a CPU-only venv automatically — all features work, indexing is just slower.

**Steps:**

```bash
# 1. Clone the repo
git clone https://github.com/wentzeld/docvault.git ~/docvault
cd ~/docvault

# 2. Copy and configure .env
cp .env.example .env
chmod 600 .env
# Edit .env — at minimum set DOCVAULT_AUTH_SECRET_KEY:
#   openssl rand -hex 32   → paste the output as DOCVAULT_AUTH_SECRET_KEY

# 3. Run the install script (idempotent — safe to re-run)
bash scripts/install.sh
```

The install script handles all 11 steps automatically:

| Step | What it does |
|------|-------------|
| 1 | Installs PostgreSQL 16 + pgvector, creates `docvault` DB role |
| 2 | Verifies Node.js 22 |
| 3 | Sets up Python venv at `~/ml-env` — uses existing if present (GPU+CUDA), creates a CPU-only one if not |
| 4 | `npm install` |
| 5 | Installs Python deps (sentence-transformers, psycopg, aiohttp, python-dotenv) |
| 6 | Downloads `nomic-embed-text-v1.5` embedding model to `~/.cache/docvault/models` |
| 7 | `npm run build` (TypeScript → `dist/`) |
| 8 | Runs database migrations |
| 9 | Prompts you to set the `admin` user password + creates an admin API token |
| 10 | Configures Caddy on your Tailscale IP |
| 11 | Enables and starts `docvault-api` and `docvault-worker` as systemd services |

> **Note:** The embedding model download (~270MB) takes a minute on first run. The worker needs up to 2 minutes to load on first start (longer on CPU) — this is normal.

### Embedding device (GPU vs CPU)

The worker auto-detects the best available device. You can override this in `.env`:

```bash
# auto  — use CUDA if available, fall back to CPU (default)
# cuda  — require GPU; warns and falls back to CPU if not found
# cpu   — always use CPU
DOCVAULT_EMBEDDING_DEVICE=auto
```

All features work on CPU. The only difference is indexing speed — a GPU embeds a document in ~100ms; CPU takes a few seconds per doc. For low-to-medium document volumes this is imperceptible.

---

## 2. Verify It's Running

```bash
# Check service status
systemctl status docvault-api docvault-worker

# Watch live logs
journalctl -u docvault-api -u docvault-worker -f

# Health check (replace with your Tailscale IP)
TAILSCALE_IP=$(tailscale ip -4)
curl http://$TAILSCALE_IP/health
# Expected: {"status":"ok","db":"ok","worker":"ok"}

# Open the web UI
echo "http://$TAILSCALE_IP"
```

If the worker shows `"worker":"degraded"` on the health check, embeddings are still loading — wait 60–120 seconds and retry. Search still works in keyword mode while the worker loads.

---

## 3. Users, Bots & API Keys

### Admin user (web UI login)

The install script creates the `admin` user. To change the password later:

```bash
node dist/api/cli/index.js admin user set-password --username admin
```

To create additional human users:

```bash
node dist/api/cli/index.js admin user set-password --username alice
```

### API tokens (for bots and scripts)

Tokens are bearer tokens. The raw token is shown **once** at creation — store it immediately in your bot's secrets.

```bash
# Create a token for a bot (read+write access)
node dist/api/cli/index.js admin token create \
  --name "mybot" \
  --agent-id "mybot" \
  --scopes "read,write"

# Create an admin token (full access including agent/token management)
node dist/api/cli/index.js admin token create \
  --name "admin-script" \
  --agent-id "admin" \
  --scopes "read,write,admin"

# Create a token with an expiry
node dist/api/cli/index.js admin token create \
  --name "ci-pipeline" \
  --agent-id "ci" \
  --scopes "read,write" \
  --expires "2027-01-01T00:00:00Z"

# List all tokens
node dist/api/cli/index.js admin token list

# Revoke a token
node dist/api/cli/index.js admin token revoke --id <token-uuid>
```

**Scopes:**
- `read` — fetch and search documents
- `write` — create/update documents, post comments
- `admin` — manage agents, tokens, and users

### Registering a bot as an agent

Agents are named identities that own documents and can receive webhook notifications. Register them via the API (requires admin token):

```bash
DOCVAULT_URL="http://$(tailscale ip -4)"
ADMIN_TOKEN="<your-admin-token>"

# Register a bot agent (no webhook)
curl -s -X POST "$DOCVAULT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id": "mybot"}'

# Register a bot agent WITH webhook notifications
curl -s -X POST "$DOCVAULT_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "mybot",
    "webhook_url": "http://your-bot-host/webhook/docvault",
    "webhook_events": ["comment.created", "review.assigned", "document.updated"]
  }'
# The response includes a one-time webhook_secret — store it in your bot's .env
```

**Webhook events:** `comment.created`, `comment.resolved`, `review.assigned`, `review.complete`, `document.created`, `document.updated`

---

## 4. Connecting Bots to DocVault

Bots interact with DocVault over the REST API using their bearer token. All endpoints are under `/api/v1/`.

### Environment variables to set in your bot

```bash
DOCVAULT_URL=http://<tailscale-ip>        # no trailing slash
DOCVAULT_TOKEN=<bearer-token-from-step-3>
```

### Common bot operations

**Post a document:**
```bash
curl -X POST "$DOCVAULT_URL/api/v1/documents" \
  -H "Authorization: Bearer $DOCVAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Feature X — PRD",
    "type": "prd",
    "project": "my-project",
    "content": "## Overview\n\nMarkdown content here...",
    "tags": ["feature-x", "q3"],
    "agent_id": "mybot"
  }'
```

Response `201`:
```json
{
  "id": "1f8c2a9e-…",
  "title": "Feature X — PRD",
  "type": "prd",
  "project": "my-project",
  "tags": ["feature-x", "q3"],
  "version": 1,
  "words": 312,
  "workflow_status": "draft",
  "embed_status": "pending",
  "created": "2026-06-23T18:04:11Z",
  "updated": "2026-06-23T18:04:11Z"
}
```
> Capture `id` — every follow-up call (fetch, comment, review, status) needs it. Embedding is asynchronous (`embed_status: "pending"`): the doc is keyword-searchable immediately and semantically searchable once `embed_status` becomes `ready`.

**Fetch a document:**
```bash
curl "$DOCVAULT_URL/api/v1/documents/<doc-id>" \
  -H "Authorization: Bearer $DOCVAULT_TOKEN"
```

**Search:**
```bash
curl -X POST "$DOCVAULT_URL/api/v1/search" \
  -H "Authorization: Bearer $DOCVAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"q": "user authentication flow", "mode": "hybrid", "project": "my-project"}'
# mode: "semantic" | "keyword" | "hybrid" (default: hybrid)
```

Response `200`:
```json
{
  "data": [
    {
      "id": "1f8c2a9e-…",
      "title": "Feature X — PRD",
      "type": "prd",
      "project": "my-project",
      "tags": ["feature-x", "q3"],
      "score": 0.0312,
      "snippet": "…matched text, max 120 chars…",
      "created": "2026-06-23T18:04:11Z",
      "updated": "2026-06-23T18:04:11Z"
    }
  ]
}
```
> `score` is the RRF rank (higher = more relevant). Search returns up to `limit` results (default 10, max 50) and is **not** paginated. If the embedding worker is down, hybrid/semantic degrade to keyword automatically.

**Post a comment on a document:**
```bash
curl -X POST "$DOCVAULT_URL/api/v1/documents/<doc-id>/comments" \
  -H "Authorization: Bearer $DOCVAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Addressed the auth requirements in section 3.", "type": "page"}'
```

Response `201`:
```json
{
  "id": "a3e1…",
  "doc": "1f8c2a9e-…",
  "author": "mybot",
  "type": "page",
  "body": "Addressed the auth requirements in section 3.",
  "round": 1,
  "created": "2026-06-23T18:10:02Z",
  "updated": "2026-06-23T18:10:02Z"
}
```
> Note the short field name `doc` (the document id), not `document_id`. For an **inline** comment, also send a `selector` (`{quote:{exact,pre,post}, pos:{start,end}}`) — see the API reference.

**Request a review (assign reviewers):**
```bash
curl -X POST "$DOCVAULT_URL/api/v1/documents/<doc-id>/reviews" \
  -H "Authorization: Bearer $DOCVAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reviewers": ["alice", "bob"],
    "instructions": "Please check the acceptance criteria in section 4.",
    "deadline": "2026-06-20T23:59:00Z"
  }'
```

**Update document workflow status:**
```bash
# Statuses: draft → in_review → synthesizing → final
curl -X PATCH "$DOCVAULT_URL/api/v1/documents/<doc-id>" \
  -H "Authorization: Bearer $DOCVAULT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workflow_status": "in_review"}'
```

### Document types

| Type | Use for |
|------|---------|
| `prd` | Product requirements documents |
| `research` | Research briefs, prior art |
| `design` | Technical design docs |
| `architecture` | Architecture overviews |
| `notes` | Freeform notes, meeting outputs |

### Response conventions (read this before integrating an agent)

All responses are JSON. A few conventions agents must account for (full field-level reference in [`API.md`](API.md)):

- **Short field names.** List/search/comment responses use terse keys — e.g. `doc` (not `document_id`), `score`, `snippet`, `created`/`updated`.
- **Sparse objects.** `null`/`false` fields are omitted by default; pass `?nulls=true` to include them.
- **`content` is omitted from list responses** unless you pass `?content=true`. A single-doc `GET /documents/:id` always includes it.
- **Cursor pagination.** List endpoints return a `next` cursor when more rows exist — pass it back as `?after=<cursor>`. Search is the exception: it returns up to `limit` ranked results and is not paginated.
- **Async embedding.** New/updated docs come back as `embed_status: "pending"`. Keyword search works at once; semantic/hybrid includes the doc once embedding finishes.
- **Optimistic locking.** `PUT /documents/:id` requires the current `version` in the body. A stale version returns `409 version_conflict` — refetch, reapply, retry.

### Error format

Every error returns the same envelope, with the HTTP status mirrored in the body:

```json
{ "status": 409, "error": "bot_working", "detail": "A bot is currently editing this document" }
```

Branch on the `error` string (stable), not the `detail` prose (human-facing). Codes you'll encounter:

| Status | `error` | When |
|--------|---------|------|
| 400 | `validation_error` | Body or query failed schema validation |
| 401 | `missing_token` · `invalid_token` · `session_expired` | Absent or bad auth |
| 403 | `forbidden` | Token lacks the required scope (e.g. `write`/`admin`) |
| 404 | `not_found` | Document or comment doesn't exist |
| 409 | `version_conflict` | `PUT` with a stale `version` — refetch and retry |
| 409 | `bot_working` · `conflict` | Document locked by an in-flight write — back off and retry |
| 413 | `payload_too_large` | Document content exceeds 2 MB |
| 422 | `no_agent` | Action needs an agent identity the token doesn't carry |
| 429 | `rate_limited` | Rate limit exceeded (see below) |
| 503 | — | Embedding worker unavailable; search falls back to keyword mode |

### Rate limits

The API rate-limits per client — default **200 requests / 60 s**, tunable via `DOCVAULT_RATE_LIMIT_MAX` and `DOCVAULT_RATE_LIMIT_TIME_WINDOW_MS`. Exceeding it returns `429 rate_limited` with a `Retry-After` header; honour it and back off exponentially.

### Full API reference

The snippets above cover the common integration path. For the complete endpoint catalogue — every route, full request/response schema, query params, auth scope, and side-effects — see **[`API.md`](API.md)**, the standalone API reference.

---

## 5. Using the Web UI

Open `http://<tailscale-ip>` in your browser and log in with your username and password.

### Viewing and searching documents

- **Doc list:** browse all documents, filter by project/type/status/tags
- **Search bar:** hybrid semantic + keyword search across all docs
- **Click a doc** to open the full rendered Markdown view

### Reviewing a document

When a bot assigns you as a reviewer:

1. Open the document — a **Review panel** appears if you have a pending review
2. Read the content and any inline comments
3. Mark your review **complete** (approved) or **skipped** (not applicable)
4. If changes are needed, add a comment (see below) before marking complete

### Commenting

- **Page comment:** general comment on the document — use the comment box in the right panel
- **Inline comment:** highlight text in the document body → a tooltip appears → click to add an anchored comment
- **Reply:** click Reply under any existing comment to thread a response
- **Resolve:** click the checkmark on a comment to mark it resolved

### Workflow statuses

| Status | Meaning |
|--------|---------|
| `draft` | Work in progress — not ready for review |
| `in_review` | Assigned to reviewers |
| `synthesizing` | Bot is incorporating feedback |
| `final` | Approved and locked |

---

## 6. Accessing DocVault on Mobile via Tailscale

DocVault is served on your Tailscale private network — no port forwarding, no public exposure.

**Setup (one-time per device):**

1. Install the [Tailscale app](https://tailscale.com/download) on your phone (iOS or Android)
2. Sign in with the same Tailscale account used on the server
3. Enable the VPN in the app
4. Find your server's Tailscale IP on the server: `tailscale ip -4`
5. Open `http://<tailscale-ip>` in your mobile browser

**That's it.** Tailscale handles the encrypted WireGuard tunnel — plain HTTP over Tailscale is fine since the traffic never touches the public internet.

> **Tip:** Bookmark the URL or add it to your home screen for quick access. If the page doesn't load, check that Tailscale is connected on both the phone and the server (`tailscale status`).

---

## 7. Backups

The `backup` command pipes `pg_dump` through `gzip` to a timestamped
`.sql.gz` file. It backs up the **database only** — your `.env` is *not*
included, so keep your own copy of it. The most recent backups are retained
(`--keep`, default 30); older ones are rotated out automatically.

```bash
# Manual backup → ./backups/docvault_<timestamp>.sql.gz
node dist/api/cli/index.js backup

# Backups are written to ./backups/ (relative to the current directory) by
# default. Override the location and retention with flags or an env var:
node dist/api/cli/index.js backup --dir /var/backups/docvault --keep 60
#   …or: DOCVAULT_BACKUP_DIR=/var/backups/docvault node dist/api/cli/index.js backup

ls -lh ./backups/
```

To restore (the dump is gzipped, so decompress as you pipe it in):
```bash
gunzip -c ./backups/<dump-file>.sql.gz | psql "$DOCVAULT_DATABASE_URL"
```

Consider scheduling a nightly backup with cron (the `cd` sets the working
directory, so backups land in `~/docvault/backups/`):
```bash
# crontab -e
0 2 * * * cd ~/docvault && node dist/api/cli/index.js backup
```

---

## 8. Maintenance

### Restart services

```bash
sudo systemctl restart docvault-api
sudo systemctl restart docvault-worker
```

### Re-index embeddings

If the embedding worker was down when documents were ingested, re-index them:

```bash
node dist/api/cli/index.js admin reindex
```

### Update DocVault

```bash
cd ~/docvault
git pull
npm install
npm run build
sudo systemctl restart docvault-api docvault-worker
```

> **Migrations:** The install script applies all files in `src/db/migrations/*.sql` automatically and is safe to re-run — all statements use `IF NOT EXISTS`. Run `bash scripts/install.sh` after an update to pick up any new migrations.

### Rotate a bot's webhook secret

```bash
ADMIN_TOKEN="<your-admin-token>"
curl -X POST "$DOCVAULT_URL/api/v1/agents/mybot/rotate-secret" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# Returns the new secret — update it in your bot's .env immediately
```

### Log locations

```bash
journalctl -u docvault-api -f          # API server logs
journalctl -u docvault-worker -f       # Embedding worker logs
tail -f /var/log/caddy/docvault-access.log  # HTTP access logs
```

---

## What's not covered yet

Things you may want to add as the project grows:

- **Multi-user auth** — currently only bcrypt password auth; no OAuth/SSO
- **Role-based permissions** — all human users have the same access level; bots are scoped by token
- **Version history UI** — the DB tracks document versions but the frontend doesn't expose a diff view yet
- **Email/push notifications** — reviews and comments trigger webhooks to bots but no email notifications to humans
- **Automated backups** — manual only right now (see [Backups](#7-backups))
- **SSL/TLS** — plain HTTP over Tailscale is fine for private use; if you expose to the public internet you'll need HTTPS
