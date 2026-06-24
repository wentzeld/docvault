import type {
  FastifyRequest,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify';
import { config } from '../../config.js';

export const requireAuth: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  // Try bearer token first
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const row = await request.server.verifyBearerToken(token);
    if (row) {
      request.user = {
        type: 'token',
        agentId: row.agent_id,
        tokenId: row.id,
        scopes: row.scopes,
      };
      return;
    }
    return reply.status(401).send({
      status: 401,
      error: 'invalid_token',
      detail: 'Bearer token is invalid or revoked',
    });
  }

  // Try session cookie
  const cookieName = config.auth.session_cookie_name;
  const sessionId = request.cookies?.[cookieName];
  if (sessionId) {
    const session = await request.server.verifySession(sessionId);
    if (session) {
      request.user = {
        type: 'session',
        username: session.username,
        scopes: ['read', 'write', 'admin'],
      };
      return;
    }
    return reply.status(401).send({
      status: 401,
      error: 'session_expired',
      detail: 'Session has expired — please log in again',
    });
  }

  return reply.status(401).send({
    status: 401,
    error: 'missing_token',
    detail: 'Authorization header or session cookie required',
  });
};

// Build a preHandler that requires authentication AND a specific scope.
// Sessions are granted read/write/admin; tokens carry only the scopes they
// were minted with, so e.g. a read-only token is rejected from write routes.
export function requireScope(scope: string): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    // @ts-expect-error – next callback not needed when called directly
    await requireAuth(request, reply, () => {});
    if (reply.sent) return;

    const user = request.user;
    if (!user || !user.scopes?.includes(scope)) {
      return reply.status(403).send({
        status: 403,
        error: 'forbidden',
        detail: `Scope '${scope}' required`,
      });
    }
  };
}

export const requireWrite: preHandlerHookHandler = requireScope('write');

export const requireAdmin: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply
) => {
  // @ts-expect-error – next callback not needed when called directly
  await requireAuth(request, reply, () => {});
  if (reply.sent) return;

  const user = request.user;
  if (!user || !user.scopes?.includes('admin')) {
    return reply.status(403).send({ status: 403, error: 'forbidden', detail: 'Admin scope required' });
  }
};
