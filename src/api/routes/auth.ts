import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, gt, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { users, sessions } from '../../db/schema.js';
import { config } from '../../config.js';
import { Errors } from '../lib/errors.js';

const LoginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1000),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/auth/login
  fastify.post(
    '/auth/login',
    async (request, reply) => {
      const body = LoginSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send(Errors.validationError(body.error.message));
      }

      const [user] = await fastify.db
        .select()
        .from(users)
        .where(eq(users.username, body.data.username))
        .limit(1);

      if (!user) {
        return reply.status(401).send({
          status: 401,
          error: 'invalid_credentials',
          detail: 'Invalid username or password',
        });
      }

      const valid = await bcrypt.compare(body.data.password, user.password_hash);
      if (!valid) {
        return reply.status(401).send({
          status: 401,
          error: 'invalid_credentials',
          detail: 'Invalid username or password',
        });
      }

      // Create session
      const expiresAt = new Date(
        Date.now() + config.auth.session_ttl_seconds * 1000
      );

      const [session] = await fastify.db
        .insert(sessions)
        .values({
          username: user.username,
          expires_at: expiresAt,
          ip: request.ip,
          user_agent: request.headers['user-agent'] ?? null,
        })
        .returning();

      if (!session) {
        return reply.status(500).send(Errors.internalError());
      }

      // secure: false — served over HTTP on Tailscale (WireGuard encrypts the link)
      reply.setCookie(config.auth.session_cookie_name, session.id, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        path: '/',
        maxAge: config.auth.session_ttl_seconds,
      });

      return reply.send({ username: user.username });
    }
  );

  // GET /api/v1/auth/me — check current session
  fastify.get(
    '/auth/me',
    async (request, reply) => {
      const cookieName = config.auth.session_cookie_name;
      const sessionId = request.cookies?.[cookieName];

      if (!sessionId) {
        return reply.status(401).send({
          status: 401,
          error: 'not_authenticated',
          detail: 'No active session',
        });
      }

      const session = await fastify.verifySession(sessionId);
      if (!session) {
        return reply.status(401).send({
          status: 401,
          error: 'session_expired',
          detail: 'Session expired',
        });
      }

      return reply.send({ username: session.username });
    }
  );

  // POST /api/v1/auth/logout
  fastify.post(
    '/auth/logout',
    async (request, reply) => {
      const cookieName = config.auth.session_cookie_name;
      const sessionId = request.cookies?.[cookieName];

      if (sessionId) {
        await fastify.db
          .delete(sessions)
          .where(eq(sessions.id, sessionId))
          .catch(() => {});
      }

      reply.clearCookie(cookieName, {
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
      });
      return reply.status(204).send();
    }
  );
}
