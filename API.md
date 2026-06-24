# DocVault API Reference

The authoritative, complete endpoint contract for the DocVault REST API — every
route, request and response schema, query parameter, auth scope, and
side-effect.

- **New to the API?** Start with the guided integration path in the
  [README — *Connecting Bots to DocVault*](README.md#4-connecting-bots-to-docvault),
  which has copy-paste `curl` examples, sample responses, the error table, and
  rate limits.
- **This file** is the full reference: load it standalone when you need the
  exact shape of any endpoint.

All routes are under `/api/v1/` (except `/health`). Auth abbreviations:
**B** = bearer token required · **S** = session cookie required ·
**B|S** = either · **A** = admin scope required.

Response conventions (apply across all endpoints):

- List responses use **short field names** and omit `null`/`false` fields unless
  `?nulls=true` is passed; `content` is omitted from list responses unless
  `?content=true`.
- List endpoints use **cursor pagination** via a `next` field (pass back as
  `?after=<cursor>`). Search returns up to `limit` ranked results and is not
  paginated.
- All errors share one flat shape — see [§4.9](#49-error-shape).

---

### 4.1 Health

```
GET /health
Auth: none
Response 200: { status: "ok", version: string, db: "ok"|"degraded", worker: "ok"|"degraded" }
```

### 4.2 Documents

**Shape notes (FR-API-00):**
- Short field names in list responses (see shapes below)
- `content` omitted from list unless `?content=true`
- Null/false fields omitted unless `?nulls=true`
- Cursor pagination via `next` field

```
POST /api/v1/documents
Auth: B|S
Body:
  {
    title: string,            // required, 1-500 chars
    content: string,          // required, markdown
    type: "prd"|"research"|"design"|"architecture"|"notes",
    project: string,          // required, slug /^[a-z0-9-]{1,80}$/
    tags?: string[],          // max 20, each max 50 chars
    agent_id?: string,        // set automatically from token if omitted
    metadata?: object
  }
Response 201:
  {
    id: string,
    title: string,
    type: string,
    project: string,
    tags: string[],
    version: 1,
    words: number,
    workflow_status: "draft",
    embed_status: "pending",
    created: string,          // ISO8601
    updated: string
  }
Errors: 400 (validation), 401, 413 (content > 2MB)

GET /api/v1/documents
Auth: B|S
Query:
  project?: string
  type?: "prd"|"research"|"design"|"architecture"|"notes"
  tags?: string               // comma-separated, AND match
  workflow_status?: string
  after?: string              // ISO8601 created_at cursor
  limit?: number              // default 10, max 50
  content?: boolean           // default false
  nulls?: boolean             // default false
Response 200:
  {
    data: [
      {
        id: string,
        title: string,
        type: string,
        project: string,
        tags: string[],
        version: number,
        words: number,
        workflow_status: string,
        embed_status: string,
        created: string,
        updated: string,
        // content: string    — only if ?content=true
        // agent_id: string   — only if not null or ?nulls=true
        // commented_at: string — only if not null or ?nulls=true
      }
    ],
    next?: string             // cursor for next page, omitted if no more
  }
Errors: 400, 401

GET /api/v1/documents/:id
Auth: B|S
Response 200:
  {
    id: string,
    title: string,
    content: string,          // always included on single-doc GET
    type: string,
    project: string,
    tags: string[],
    agent_id?: string,
    metadata?: object,
    version: number,
    words: number,
    workflow_status: string,
    embed_status: string,
    embed_model?: string,
    commented_at?: string,
    created: string,
    updated: string
  }
Errors: 401, 404

PUT /api/v1/documents/:id
Auth: B|S
Body: Partial of POST body (any subset). version must match current (optimistic lock).
  { title?, content?, type?, project?, tags?, metadata?, version: number }
Response 200: Same shape as GET single (reflects new version)
Errors: 400, 401, 404, 409 (version conflict)
Side-effects:
  - Increments version
  - Sets embed_status = 'pending', enqueues embed-document job
  - Sets anchor_lost = true on comments whose pos offsets fall outside new content length

DELETE /api/v1/documents/:id
Auth: B|S
Response 204: (no body)
Errors: 401, 404
Side-effect: sets deleted_at = NOW() (soft delete)
```

### 4.3 Comments

```
POST /api/v1/documents/:id/comments
Auth: B|S
Body:
  {
    body: string,             // required, max 10000 chars
    type?: "inline"|"page",   // default "page"
    parent_id?: string,       // UUID, must belong to same doc
    selector?: {
      quote: { exact: string, pre: string, post: string },
      pos: { start: number, end: number }
    },
    round?: number            // default 1
  }
Response 201:
  {
    id: string,
    doc: string,              // doc_id
    author: string,
    type: string,
    body: string,
    round: number,
    created: string,
    updated: string,
    // parent: string         — only if not null
    // selector: {...}        — only if inline
    // resolved: bool         — omitted if false (FR-API-00)
    // anchor_lost: bool      — omitted if false
  }
Errors: 400, 401, 404 (doc not found), 422 (parent not in same doc)
Side-effect: updates documents.commented_at = NOW()

GET /api/v1/documents/:id/comments
Auth: B|S
Query:
  round?: number
  resolved?: boolean
  author?: string
  group_by?: "author"         // returns { author: string, comments: Comment[] }[]
  after?: string              // cursor (comment id)
  limit?: number              // default 50, max 200
  nulls?: boolean
Response 200:
  {
    data: Comment[] | GroupedByAuthor[],
    next?: string
  }
Errors: 400, 401, 404

PATCH /api/v1/documents/:id/comments/:commentId
Auth: B|S (only author or admin may edit)
Body: { body?: string, resolved?: boolean }
Response 200: Updated Comment shape (same as POST response)
Errors: 400, 401, 403, 404

DELETE /api/v1/documents/:id/comments/:commentId
Auth: B|S (only author or admin)
Response 204
Errors: 401, 403, 404
Side-effect:
  - If comment has replies: sets body = "[deleted]", deleted_at = NOW() (tombstone)
  - If no replies: hard-soft-delete (deleted_at = NOW(), body cleared)
```

### 4.4 Search

```
POST /api/v1/search
Auth: B|S
Body:
  {
    q: string,                // required, 1-500 chars
    mode?: "semantic"|"keyword"|"hybrid",  // default "hybrid"
    type?: "prd"|"research"|"design"|"architecture"|"notes",
    project?: string,
    tags?: string[],          // AND filter
    after?: string,           // ISO8601 date filter on created_at
    before?: string,
    limit?: number,           // default 10, max 50
    rrf_k?: number,           // default 60
    ef_search?: number        // default 100 (pgvector ef_search hint)
  }
Response 200:
  {
    data: [
      {
        id: string,
        title: string,
        type: string,
        project: string,
        tags: string[],
        score: number,        // RRF score
        snippet: string,      // max 120 chars
        created: string,
        updated: string
      }
    ]
    // No cursor: search is not paginated beyond limit
  }
Errors: 400, 401, 503 (worker unavailable, degraded mode — keyword only)
```

### 4.5 Reviews

```
POST /api/v1/documents/:id/reviews
Auth: B|S
Body:
  {
    reviewers: string[],      // array of agent_id / username, min 1
    round?: number,           // default 1
    deadline?: string,        // ISO8601
    notify_on_complete?: string  // agent_id to webhook when all done
  }
Response 201:
  {
    doc: string,
    round: number,
    reviewers: [
      { reviewer: string, status: "pending" }
    ],
    deadline?: string,
    notify_on_complete?: string
  }
Side-effect: sets workflow_status = 'in_review'
Errors: 400, 401, 404, 409 (active review round already open)

GET /api/v1/documents/:id/reviews
Auth: B|S
Query: round?: number (default: latest)
Response 200:
  {
    doc: string,
    round: number,
    reviewers: [
      { reviewer: string, status: string, completed_at?: string }
    ],
    all_done: boolean
  }
Errors: 401, 404

PATCH /api/v1/documents/:id/reviews/:reviewer
Auth: B|S (reviewer must match token agent_id or admin)
Body: { status: "in_progress"|"complete"|"skipped" }
Response 200: Same as GET reviews
Side-effects:
  - If all reviewers complete/skipped:
      - fires notify_on_complete webhook (via pg-boss notify-webhook job)
      - sets workflow_status = 'synthesizing'
Errors: 400, 401, 403, 404
```

### 4.6 Agents & Webhooks

```
POST /api/v1/agents
Auth: B (admin scope)
Body: { id: string, webhook_url?: string, webhook_events?: string[] }
Response 201:
  {
    id: string,
    webhook_secret: string,   // raw secret shown ONCE, not stored
    webhook_events: string[]
  }
Errors: 400, 401, 403, 409 (id taken)

GET /api/v1/agents
Auth: B (admin scope)
Response 200: { data: [{ id, webhook_url, webhook_events, active, created }] }

PATCH /api/v1/agents/:agentId
Auth: B (admin scope)
Body: { webhook_url?, webhook_events?, active? }
Response 200: Agent shape (no secret)
Errors: 401, 403, 404

POST /api/v1/agents/:agentId/rotate-secret
Auth: B (admin scope)
Response 200: { webhook_secret: string }  // new raw secret shown once
Errors: 401, 403, 404
```

### 4.7 Tokens

```
POST /api/v1/tokens
Auth: B (admin scope)
Body:
  {
    name: string,
    agent_id: string,
    scopes?: string[],        // default ["read","write"]
    expires_at?: string       // ISO8601, null = never
  }
Response 201:
  {
    id: string,
    token: string,            // raw token shown ONCE: "dv_<32 random bytes hex>"
    name: string,
    agent_id: string,
    scopes: string[],
    expires_at?: string
  }
Errors: 400, 401, 403

GET /api/v1/tokens
Auth: B (admin scope)
Response 200: { data: [{ id, name, agent_id, scopes, last_used_at, expires_at, revoked, created }] }

DELETE /api/v1/tokens/:id
Auth: B (admin scope)
Response 204
Errors: 401, 403, 404
```

### 4.8 Auth (Browser Sessions)

```
POST /api/v1/auth/login
Auth: none
Body: { username: string, password: string }
Response 200: { username: string }
Sets cookie: docvault_session=<sessionId>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800
Errors: 400, 401

POST /api/v1/auth/logout
Auth: S
Response 204
Clears cookie, deletes session row
```

### 4.9 Error Shape

All errors follow this flat shape (no envelope):

```typescript
{
  status: number,    // HTTP status code
  error: string,     // machine-readable slug, e.g. "not_found"
  detail: string     // human-readable message
}
```
