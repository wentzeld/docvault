// Reciprocal Rank Fusion SQL builder
// Returns parameterized SQL for hybrid search combining pgvector + tsvector
//
// Keyword matching combines TWO tsqueries:
//   1. websearch_to_tsquery('english', q) — whole-word, stemmed matching
//   2. to_tsquery('simple', 'term:* & ...') — PREFIX matching, so partial
//      words match: "data" finds "database" (lexeme databas), which
//      whole-word FTS can never do. Essential for search-as-you-type.
// Ranking takes the better of the two.

export interface RrfSearchParams {
  queryEmbedding: number[] | null;
  queryText: string;
  limit: number;
  rrfK: number;
  efSearch: number;
  type?: string;
  project?: string;
  tags?: string[];
  after?: string;
  before?: string;
  mode: 'semantic' | 'keyword' | 'hybrid';
}

export interface RrfSqlResult {
  sql: string;
  params: unknown[];
}

/**
 * Build a prefix tsquery string from raw user input.
 * Hard-sanitized to alphanumeric tokens so to_tsquery can never throw on
 * user-supplied syntax. Returns null when no usable tokens remain.
 */
export function buildPrefixQuery(queryText: string): string | null {
  const tokens = queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t}:*`).join(' & ');
}

export function buildRrfQuery(p: RrfSearchParams): RrfSqlResult {
  const params: unknown[] = [];
  let paramIdx = 1;

  function addParam(val: unknown): string {
    params.push(val);
    return `$${paramIdx++}`;
  }

  // Build WHERE clause for filters
  const filters: string[] = [`d.deleted_at IS NULL`];
  if (p.type) filters.push(`d.type = ${addParam(p.type)}::doc_type`);
  if (p.project) filters.push(`d.project = ${addParam(p.project)}`);
  if (p.tags && p.tags.length > 0) filters.push(`d.tags @> ${addParam(p.tags)}::text[]`);
  if (p.after) filters.push(`d.created_at > ${addParam(p.after)}`);
  if (p.before) filters.push(`d.created_at < ${addParam(p.before)}`);

  const filterSql = filters.join(' AND ');
  const innerLimit = p.limit * 3; // fetch more candidates for fusion

  const limitParam = addParam(p.limit);
  const innerLimitParam = addParam(innerLimit);
  const rrfKParam = addParam(p.rrfK);

  const prefixQuery = buildPrefixQuery(p.queryText);

  // Keyword match + rank SQL fragments (word match OR prefix match,
  // ranked by whichever scores higher).
  function keywordFragments(): { match: string; rank: string } {
    const queryParam = addParam(p.queryText);
    if (prefixQuery) {
      const prefixParam = addParam(prefixQuery);
      return {
        match:
          `(d.tsvector_col @@ websearch_to_tsquery('english', ${queryParam})` +
          ` OR d.tsvector_col @@ to_tsquery('simple', ${prefixParam}))`,
        rank:
          `GREATEST(` +
          `ts_rank_cd(d.tsvector_col, websearch_to_tsquery('english', ${queryParam})), ` +
          `ts_rank_cd(d.tsvector_col, to_tsquery('simple', ${prefixParam}))` +
          `)`,
      };
    }
    return {
      match: `d.tsvector_col @@ websearch_to_tsquery('english', ${queryParam})`,
      rank: `ts_rank_cd(d.tsvector_col, websearch_to_tsquery('english', ${queryParam}))`,
    };
  }

  let sql: string;

  if (p.mode === 'keyword') {
    const kw = keywordFragments();
    sql = `
      WITH keyword AS (
        SELECT
          d.id,
          d.title,
          d.type,
          d.project,
          d.tags,
          d.words,
          d.workflow_status,
          d.embed_status,
          d.created_at,
          d.updated_at,
          d.commented_at,
          d.content,
          ROW_NUMBER() OVER (
            ORDER BY ${kw.rank} DESC
          ) AS rank,
          ${kw.rank} AS raw_score
        FROM documents d
        WHERE ${filterSql}
          AND ${kw.match}
        ORDER BY raw_score DESC
        LIMIT ${innerLimitParam}
      )
      SELECT
        id, title, type::text, project, tags, words, workflow_status::text,
        embed_status::text, created_at, updated_at, commented_at, content,
        (1.0 / (${rrfKParam}::float + rank)) AS score
      FROM keyword
      ORDER BY score DESC
      LIMIT ${limitParam}
    `;
  } else if (p.mode === 'semantic' && p.queryEmbedding) {
    const embParam = addParam(JSON.stringify(p.queryEmbedding));
    const efParam = addParam(p.efSearch);
    sql = `
      WITH setup AS (
        SELECT set_config('hnsw.ef_search', ${efParam}::text, true)
      ),
      semantic AS (
        SELECT
          d.id,
          d.title,
          d.type,
          d.project,
          d.tags,
          d.words,
          d.workflow_status,
          d.embed_status,
          d.created_at,
          d.updated_at,
          d.commented_at,
          d.content,
          ROW_NUMBER() OVER (
            ORDER BY d.embedding <=> ${embParam}::vector
          ) AS rank
        FROM documents d, setup
        WHERE ${filterSql}
          AND d.embedding IS NOT NULL
          AND d.embed_status = 'ready'
        ORDER BY d.embedding <=> ${embParam}::vector
        LIMIT ${innerLimitParam}
      )
      SELECT
        id, title, type::text, project, tags, words, workflow_status::text,
        embed_status::text, created_at, updated_at, commented_at, content,
        (1.0 / (${rrfKParam}::float + rank)) AS score
      FROM semantic
      ORDER BY score DESC
      LIMIT ${limitParam}
    `;
  } else {
    // hybrid (or semantic fallback to keyword when no embedding)
    if (p.queryEmbedding) {
      const embParam = addParam(JSON.stringify(p.queryEmbedding));
      const efParam = addParam(p.efSearch);
      const kw = keywordFragments();
      sql = `
        WITH setup AS (
          SELECT set_config('hnsw.ef_search', ${efParam}::text, true)
        ),
        semantic AS (
          SELECT
            d.id,
            ROW_NUMBER() OVER (ORDER BY d.embedding <=> ${embParam}::vector) AS rank
          FROM documents d, setup
          WHERE ${filterSql}
            AND d.embedding IS NOT NULL
            AND d.embed_status = 'ready'
          ORDER BY d.embedding <=> ${embParam}::vector
          LIMIT ${innerLimitParam}
        ),
        keyword AS (
          SELECT
            d.id,
            ROW_NUMBER() OVER (
              ORDER BY ${kw.rank} DESC
            ) AS rank
          FROM documents d
          WHERE ${filterSql}
            AND ${kw.match}
          ORDER BY rank
          LIMIT ${innerLimitParam}
        ),
        fused AS (
          SELECT
            COALESCE(s.id, k.id) AS id,
            COALESCE(1.0 / (${rrfKParam}::float + s.rank), 0) +
            COALESCE(1.0 / (${rrfKParam}::float + k.rank), 0) AS score
          FROM semantic s
          FULL OUTER JOIN keyword k ON s.id = k.id
        )
        SELECT
          d.id, d.title, d.type::text, d.project, d.tags, d.words,
          d.workflow_status::text, d.embed_status::text,
          d.created_at, d.updated_at, d.commented_at, d.content,
          f.score
        FROM fused f
        JOIN documents d ON d.id = f.id
        WHERE ${filterSql}
        ORDER BY f.score DESC
        LIMIT ${limitParam}
      `;
    } else {
      // Fallback to keyword-only when no embedding available
      const kw = keywordFragments();
      sql = `
        WITH keyword AS (
          SELECT
            d.id,
            d.title,
            d.type,
            d.project,
            d.tags,
            d.words,
            d.workflow_status,
            d.embed_status,
            d.created_at,
            d.updated_at,
            d.commented_at,
            d.content,
            ROW_NUMBER() OVER (
              ORDER BY ${kw.rank} DESC
            ) AS rank
          FROM documents d
          WHERE ${filterSql}
            AND ${kw.match}
          ORDER BY rank
          LIMIT ${innerLimitParam}
        )
        SELECT
          id, title, type::text, project, tags, words, workflow_status::text,
          embed_status::text, created_at, updated_at, commented_at, content,
          (1.0 / (${rrfKParam}::float + rank)) AS score
        FROM keyword
        ORDER BY score DESC
        LIMIT ${limitParam}
      `;
    }
  }

  return { sql, params };
}
