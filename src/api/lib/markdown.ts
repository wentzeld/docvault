import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import DOMPurify from 'isomorphic-dompurify';
import { LRUCache } from 'lru-cache';
import { config } from '../../config.js';
import type { Node } from 'unist';

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p','h1','h2','h3','h4','h5','h6','ul','ol','li',
      'blockquote','pre','code','strong','em','a','img','table','thead',
      'tbody','tr','th','td','br','hr','del','sup','sub','span','div'],
    ALLOWED_ATTR: ['href','src','alt','title','class','id','data-block-id',
      'target','rel'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script','style','iframe','object','embed','form','input'],
    FORBID_ATTR: ['onerror','onload','onclick','onmouseover'],
  });
}

interface CacheEntry {
  html: string;
}

const renderCache = new LRUCache<string, CacheEntry>({
  max: config.lru_cache.max_size,
  ttl: config.lru_cache.ttl_ms,
});

function remarkBlockIds() {
  return (tree: Node) => {
    visit(tree, (node: Node) => {
      if (
        ['paragraph', 'heading', 'listItem', 'blockquote', 'code'].includes(
          node.type
        )
      ) {
        const typedNode = node as Node & {
          data?: Record<string, unknown>;
          position?: {
            start: { line: number; column: number };
          };
        };
        if (!typedNode.data) typedNode.data = {};
        const data = typedNode.data as Record<string, unknown>;
        if (!data['hProperties']) data['hProperties'] = {};
        const hProps = data['hProperties'] as Record<string, string>;
        const pos = typedNode.position;
        const blockId = pos
          ? `b-${pos.start.line}-${pos.start.column}`
          : `b-${Math.random().toString(36).slice(2, 10)}`;
        hProps['data-block-id'] = blockId;
      }
    });
  };
}

const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkBlockIds)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeHighlight)
  .use(rehypeStringify);

const sanitizePipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeHighlight)
  .use(rehypeStringify);

export async function renderMarkdown(
  content: string,
  cacheKey?: string
): Promise<string> {
  if (cacheKey) {
    const cached = renderCache.get(cacheKey);
    if (cached) return cached.html;
  }

  const result = await pipeline.process(content);
  const raw = String(result);
  const html = sanitizeHtml(raw);

  if (cacheKey) {
    renderCache.set(cacheKey, { html });
  }

  return html;
}

export function invalidateCache(cacheKey: string): void {
  renderCache.delete(cacheKey);
}

export async function sanitizeBody(markdown: string): Promise<string> {
  const result = await sanitizePipeline.process(markdown);
  return sanitizeHtml(String(result));
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

export function extractKeywordSnippet(
  content: string,
  terms: string[],
  maxChars = 120
): string {
  const sentences = content
    .split(/(?<=[.?!])\s+(?=[A-Z])|(?<=\n)\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const lowerTerms = terms.map((t) => t.toLowerCase());
  for (const sentence of sentences) {
    if (lowerTerms.some((t) => sentence.toLowerCase().includes(t))) {
      return sentence.slice(0, maxChars);
    }
  }
  return (sentences[0] ?? content).slice(0, maxChars);
}
