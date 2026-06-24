import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifySensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { config } from '../config.js';
import dbPlugin from './plugins/db.js';
import bossPlugin from './plugins/boss.js';
import authPlugin from './plugins/auth.js';
import workerClientPlugin from './plugins/worker-client.js';
import errorsPlugin from './plugins/errors.js';
import { scheduleReviewDeadlineChecker } from '../jobs/reviewDeadline.js';
import { registerWebhookWorker } from '../jobs/webhook.js';
import { agents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

import { healthRoutes } from './routes/health.js';
import { documentRoutes } from './routes/documents.js';
import { commentRoutes } from './routes/comments.js';
import { searchRoutes } from './routes/search.js';
import { reviewRoutes } from './routes/reviews.js';
import { agentRoutes } from './routes/agents.js';
import { tokenRoutes } from './routes/tokens.js';
import { authRoutes } from './routes/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.server.log_level,
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url,
            headers: {
              host: req.headers.host,
              'user-agent': req.headers['user-agent'],
            },
          };
        },
      },
    },
    bodyLimit: config.server.body_limit,
    trustProxy: 1,
  });

  // Plugins
  await app.register(fastifySensible);
  await app.register(fastifyCookie);
  await app.register(fastifyCors, {
    origin: false, // Tailscale-only; no CORS needed
    credentials: true,
  });
  await app.register(fastifyRateLimit, {
    max: config.rate_limit.max,
    timeWindow: config.rate_limit.time_window_ms,
    errorResponseBuilder: () => ({
      status: 429,
      error: 'rate_limited',
      detail: 'Too many requests',
    }),
  });

  // Our plugins
  await app.register(dbPlugin);
  await app.register(bossPlugin);
  await app.register(authPlugin);
  await app.register(workerClientPlugin);
  await app.register(errorsPlugin);

  // Wire durable background jobs
  await scheduleReviewDeadlineChecker(app.boss, app.db);
  await registerWebhookWorker(app.boss, async (id) => {
    const rows = await app.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  });

  // Serve static UI files if configured
  if (config.ui.serve) {
    // __dirname = dist/api/api/ → up 3 = repo root
    const distPath = path.resolve(
      path.join(__dirname, '..', '..', '..', config.ui.dist_path)
    );
    if (fs.existsSync(distPath)) {
      await app.register(fastifyStatic, {
        root: distPath,
        prefix: '/ui/',
        decorateReply: true, // needed for reply.sendFile() in catch-all
      });

      // Redirect root → UI
      app.get('/', async (_req, reply) => {
        return reply.redirect('/ui/', 302);
      });
    }
  }

  // Health (no auth)
  await app.register(healthRoutes);

  // Auth routes (no auth on login endpoint)
  await app.register(authRoutes, { prefix: '/api/v1' });

  // Protected API routes
  await app.register(documentRoutes, { prefix: '/api/v1' });
  await app.register(commentRoutes, { prefix: '/api/v1' });
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.register(reviewRoutes, { prefix: '/api/v1' });
  await app.register(agentRoutes, { prefix: '/api/v1' });
  await app.register(tokenRoutes, { prefix: '/api/v1' });

  // Catch-all: serve SPA index.html for UI routes
  app.setNotFoundHandler(async (request, reply) => {
    if (
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/health')
    ) {
      const indexPath = path.resolve(
        path.join(__dirname, '..', '..', '..', config.ui.dist_path, 'index.html')
      );
      if (fs.existsSync(indexPath)) {
        return reply.type('text/html').sendFile('index.html', path.dirname(indexPath));
      }
    }
    return reply.status(404).send({
      status: 404,
      error: 'not_found',
      detail: 'Route not found',
    });
  });

  return app;
}
