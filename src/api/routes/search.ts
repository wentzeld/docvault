import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { buildRrfQuery } from '../lib/rrf.js';
import { extractKeywordSnippet } from '../lib/markdown.js';
import { Errors } from '../lib/errors.js';
import { getPool } from '../../db/index.js';
import { config } from '../../config.js';

const SearchSchema = z.object({
  q: z.string().min(1).max(500),
  mode: z.enum(['semantic', 'keyword', 'hybrid']).default('hybrid'),
  type: z.enum(['prd', 'research', 'design', 'architecture', 'notes']).optional(),
  project: z.string().optional(),
  tags: z.array(z.string()).optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
  rrf_k: z.number().int().min(1).default(60),
  ef_search: z.number().int().min(1).default(100),
});

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/search',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = SearchSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const p = body.data;
      let queryEmbedding: number[] | null = null;
      let effectiveMode = p.mode;

      // Get query embedding from worker (for semantic/hybrid)
      if (p.mode === 'semantic' || p.mode === 'hybrid') {
        queryEmbedding = await fastify.workerClient.embed(p.q);
        if (!queryEmbedding) {
          if (p.mode === 'semantic') {
            return reply.status(503).send(
              Errors.serviceUnavailable('Embedding worker unavailable — semantic search not available')
            );
          }
          // Hybrid degrades to keyword
          effectiveMode = 'keyword';
          fastify.log.warn('Worker unavailable — degrading to keyword search');
        }
      }

      const { sql: querySql, params } = buildRrfQuery({
        queryEmbedding,
        queryText: p.q,
        limit: p.limit,
        rrfK: p.rrf_k,
        efSearch: p.ef_search,
        type: p.type,
        project: p.project,
        tags: p.tags,
        after: p.after,
        before: p.before,
        mode: effectiveMode,
      });

      const pool = getPool();
      let rows: Array<{
        id: string;
        title: string;
        type: string;
        project: string;
        tags: string[];
        words: number;
        workflow_status: string;
        embed_status: string;
        created_at: Date;
        updated_at: Date;
        commented_at: Date | null;
        content: string;
        score: number;
      }>;

      try {
        const result = await pool.query(querySql, params);
        rows = result.rows as typeof rows;
      } catch (err) {
        fastify.log.error({ err }, 'Search query failed');
        return reply.status(500).send(Errors.internalError('Search query failed'));
      }

      const queryTerms = p.q
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1);

      // Generate snippets
      const results = await Promise.all(
        rows.map(async (row) => {
          let snippet = '';

          if (effectiveMode === 'semantic' && queryEmbedding) {
            // Ask worker for semantic snippet
            const workerSnippet = await fastify.workerClient.snippet(
              'semantic',
              row.content,
              queryEmbedding
            );
            snippet = workerSnippet ?? extractKeywordSnippet(row.content, queryTerms);
          } else {
            snippet = extractKeywordSnippet(row.content, queryTerms);
          }

          snippet = snippet.slice(0, 120);

          return {
            id: row.id,
            title: row.title,
            type: row.type,
            project: row.project,
            tags: row.tags,
            // Fields the document list row renders — omitting `words` crashed
            // the Documents page with "Cannot read properties of undefined
            // (reading 'toLocaleString')" on every search.
            words: row.words,
            status: row.workflow_status,
            indexed: row.embed_status === 'ready',
            score: (() => { const s = typeof row.score === 'number' ? row.score : parseFloat(String(row.score)); return isNaN(s) ? 0 : s; })(),
            snippet,
            created: row.created_at instanceof Date
              ? row.created_at.toISOString()
              : new Date(row.created_at).toISOString(),
            updated: row.updated_at instanceof Date
              ? row.updated_at.toISOString()
              : new Date(row.updated_at).toISOString(),
            commented: row.commented_at
              ? (row.commented_at instanceof Date
                  ? row.commented_at.toISOString()
                  : new Date(row.commented_at).toISOString())
              : null,
          };
        })
      );

      return reply.send({
        data: results,
        mode: effectiveMode, // signal if degraded
      });
    }
  );
}
