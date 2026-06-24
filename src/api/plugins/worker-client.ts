import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '../../config.js';

export interface WorkerClient {
  embed(text: string): Promise<number[] | null>;
  snippet(
    mode: 'semantic' | 'keyword',
    text: string,
    queryVecOrTerms: number[] | string[]
  ): Promise<string | null>;
  isAvailable(): Promise<boolean>;
}

async function workerClientPlugin(fastify: FastifyInstance): Promise<void> {
  const baseUrl = config.worker.url;
  const timeoutMs = config.worker.timeout_ms;
  // Optional shared secret; sent only when DOCVAULT_WORKER_TOKEN is set on both
  // the API and the worker. Matches the worker's snippet-server auth check.
  const workerToken = process.env.DOCVAULT_WORKER_TOKEN || '';
  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(workerToken ? { Authorization: `Bearer ${workerToken}` } : {}),
  };

  const client: WorkerClient = {
    async embed(text: string): Promise<number[] | null> {
      try {
        const res = await fetch(`${baseUrl}/embed`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { embedding: number[] };
        return data.embedding;
      } catch {
        return null;
      }
    },

    async snippet(mode, text, queryVecOrTerms): Promise<string | null> {
      try {
        const body =
          mode === 'semantic'
            ? { mode, text, query_vec: queryVecOrTerms }
            : { mode, text, terms: queryVecOrTerms };

        const res = await fetch(`${baseUrl}/snippet`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { snippet: string };
        return data.snippet;
      } catch {
        return null;
      }
    },

    async isAvailable(): Promise<boolean> {
      try {
        const res = await fetch(`${baseUrl}/embed`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ text: 'ping' }),
          signal: AbortSignal.timeout(2000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };

  fastify.decorate('workerClient', client);
}

export default fp(workerClientPlugin, { name: 'workerClient' });

declare module 'fastify' {
  interface FastifyInstance {
    workerClient: WorkerClient;
  }
}
