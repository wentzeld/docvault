import { describe, it, expect } from 'vitest';
import {
  sanitizeBody,
  renderMarkdown,
  countWords,
  extractKeywordSnippet,
} from '../src/api/lib/markdown';

describe('renderMarkdown', () => {
  it('renders markdown and injects data-block-id attributes', async () => {
    const html = await renderMarkdown('# Title\n\nA paragraph.');
    expect(html).toContain('data-block-id');
    expect(html).toContain('<h1');
  });

  it('strips dangerous tags (XSS)', async () => {
    const html = await renderMarkdown('ok\n\n<script>alert(1)</script>');
    expect(html).not.toContain('<script');
  });
});

describe('sanitizeBody', () => {
  it('removes script tags from comment bodies', async () => {
    const out = await sanitizeBody('Hi <script>steal()</script> there');
    expect(out).not.toContain('<script');
  });
});

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('  one two   three ')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('extractKeywordSnippet', () => {
  it('returns the sentence containing a query term', () => {
    const snip = extractKeywordSnippet(
      'First sentence. Vector search is great. End.',
      ['vector']
    );
    expect(snip.toLowerCase()).toContain('vector');
  });

  it('falls back to the first sentence when no term matches', () => {
    const snip = extractKeywordSnippet('Alpha beta. Gamma delta.', ['zzz']);
    expect(snip).toContain('Alpha');
  });
});
