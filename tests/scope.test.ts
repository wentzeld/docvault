import { describe, it, expect } from 'vitest';
import { requireScope } from '../src/api/middleware/requireAuth';

function mockReply() {
  return {
    statusCode: 0,
    sent: false,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: any) {
      this.sent = true;
      this.payload = payload;
      return this;
    },
  };
}

function mockReq(opts: { token?: string; scopes?: string[] }) {
  return {
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
    cookies: {},
    user: undefined as any,
    server: {
      verifyBearerToken: async (_t: string) =>
        opts.scopes ? { agent_id: 'a', id: 'tok', scopes: opts.scopes } : null,
    },
  };
}

const noop = (() => {}) as any;

describe('requireScope', () => {
  it('allows a token that carries the required scope', async () => {
    const req = mockReq({ token: 'x', scopes: ['read', 'write'] });
    const reply = mockReply();
    await (requireScope('write') as any)(req, reply, noop);
    expect(reply.sent).toBe(false);
    expect(req.user.scopes).toContain('write');
  });

  it('rejects a token missing the scope with 403', async () => {
    const req = mockReq({ token: 'x', scopes: ['read'] });
    const reply = mockReply();
    await (requireScope('write') as any)(req, reply, noop);
    expect(reply.statusCode).toBe(403);
    expect(reply.payload.error).toBe('forbidden');
  });

  it('rejects missing credentials with 401', async () => {
    const req = mockReq({});
    const reply = mockReply();
    await (requireScope('write') as any)(req, reply, noop);
    expect(reply.statusCode).toBe(401);
  });

  it('rejects an invalid/revoked token with 401', async () => {
    const req = mockReq({ token: 'x' }); // verifyBearerToken returns null
    const reply = mockReply();
    await (requireScope('write') as any)(req, reply, noop);
    expect(reply.statusCode).toBe(401);
  });
});
