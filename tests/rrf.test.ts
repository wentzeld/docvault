import { describe, it, expect } from 'vitest';
import { buildPrefixQuery, buildRrfQuery, type RrfSearchParams } from '../src/api/lib/rrf';

describe('buildPrefixQuery', () => {
  it('builds alphanumeric prefix tokens', () => {
    expect(buildPrefixQuery('Hello World')).toBe('hello:* & world:*');
  });

  it('drops one-char tokens and injection punctuation', () => {
    expect(buildPrefixQuery("a b'; DROP TABLE--")).toBe('drop:* & table:*');
  });

  it('returns null when nothing usable remains', () => {
    expect(buildPrefixQuery('!! _ ?')).toBeNull();
  });
});

const base: Omit<RrfSearchParams, 'mode' | 'queryEmbedding'> = {
  queryText: 'vector search',
  limit: 10,
  rrfK: 60,
  efSearch: 100,
};

describe('buildRrfQuery', () => {
  it('parameterizes all user input — no raw interpolation', () => {
    const { sql, params } = buildRrfQuery({
      ...base,
      mode: 'keyword',
      queryEmbedding: null,
      project: 'docs',
      type: 'prd',
      tags: ['x'],
    });
    expect(sql).not.toContain('vector search');
    expect(sql).not.toContain("'docs'");
    expect(params).toContain('vector search');
    expect(params).toContain('docs');
  });

  it('keyword mode hits tsvector and not the vector operator', () => {
    const { sql } = buildRrfQuery({ ...base, mode: 'keyword', queryEmbedding: null });
    expect(sql).toContain('tsvector_col');
    expect(sql).not.toContain('<=>');
  });

  it('hybrid with an embedding fuses semantic + keyword', () => {
    const { sql } = buildRrfQuery({ ...base, mode: 'hybrid', queryEmbedding: [0.1, 0.2] });
    expect(sql).toContain('FULL OUTER JOIN');
    expect(sql).toContain('<=>');
    expect(sql).toContain('tsvector_col');
  });

  it('hybrid without an embedding falls back to keyword-only', () => {
    const { sql } = buildRrfQuery({ ...base, mode: 'hybrid', queryEmbedding: null });
    expect(sql).not.toContain('<=>');
    expect(sql).toContain('tsvector_col');
  });

  it('adds a tag filter only when tags are present', () => {
    const withTags = buildRrfQuery({ ...base, mode: 'keyword', queryEmbedding: null, tags: ['a', 'b'] });
    expect(withTags.sql).toContain('@>');
    const noTags = buildRrfQuery({ ...base, mode: 'keyword', queryEmbedding: null });
    expect(noTags.sql).not.toContain('@>');
  });
});
