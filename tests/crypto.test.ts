import { describe, it, expect } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  signPayload,
  verifySignature,
  generateBearerToken,
  generateWebhookSecret,
} from '../src/api/lib/crypto';

const KEY = 'a'.repeat(64); // 32 bytes as hex

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a plaintext secret', () => {
    const ct = encryptSecret('hello secret', KEY);
    expect(ct).not.toContain('hello');
    expect(ct.split(':')).toHaveLength(3);
    expect(decryptSecret(ct, KEY)).toBe('hello secret');
  });

  it('uses a random IV (ciphertext differs each call)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('fails to decrypt with the wrong key', () => {
    const ct = encryptSecret('x', KEY);
    expect(() => decryptSecret(ct, 'b'.repeat(64))).toThrow();
  });

  it('rejects a malformed ciphertext', () => {
    expect(() => decryptSecret('not-valid', KEY)).toThrow();
  });
});

describe('signPayload / verifySignature', () => {
  it('produces a sha256= prefixed signature that verifies', () => {
    const sig = signPayload('secret', '{"a":1}');
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifySignature('secret', '{"a":1}', sig)).toBe(true);
  });

  it('rejects a tampered body or wrong secret', () => {
    const sig = signPayload('secret', 'body');
    expect(verifySignature('secret', 'tampered', sig)).toBe(false);
    expect(verifySignature('wrong', 'body', sig)).toBe(false);
  });

  it('does not throw on length-mismatched signatures', () => {
    expect(verifySignature('secret', 'body', 'sha256=short')).toBe(false);
  });
});

describe('token / secret generation', () => {
  it('mints prefixed bearer tokens and webhook secrets', () => {
    expect(generateBearerToken()).toMatch(/^dv_[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).toMatch(/^whsec_[0-9a-f]{64}$/);
  });
});
