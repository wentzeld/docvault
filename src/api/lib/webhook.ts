import { URL } from 'url';
import { signPayload, decryptSecret } from './crypto.js';
import { config } from '../../config.js';
import type { Agent } from '../../db/schema.js';

const PRIVATE_IP = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|::1$|fc|fd)/i;

export function validateWebhookUrl(raw: string): { valid: boolean; reason?: string } {
  let u: URL;
  try { u = new URL(raw); } catch { return { valid: false, reason: 'invalid_url' }; }
  if (u.protocol !== 'https:') return { valid: false, reason: 'https_required' };
  if (PRIVATE_IP.test(u.hostname)) return { valid: false, reason: 'private_ip_blocked' };
  return { valid: true };
}

export interface WebhookPayload {
  event: string;
  doc?: string;
  comment?: string;
  ts: string;
  [key: string]: unknown;
}

const RETRY_DELAYS_SEC = [1, 4, 16];

export async function dispatchWebhook(
  agent: Agent,
  payload: WebhookPayload
): Promise<void> {
  if (!agent.webhook_url || !agent.webhook_secret_enc) return;

  const secretKey = config.auth.secret_key;
  if (!secretKey) {
    console.error('DOCVAULT_AUTH_SECRET_KEY not set — cannot sign webhook');
    return;
  }

  let rawSecret: string;
  try {
    rawSecret = decryptSecret(agent.webhook_secret_enc, secretKey);
  } catch (err) {
    console.error('Failed to decrypt webhook secret for agent', agent.id, err);
    return;
  }

  const body = JSON.stringify(payload);
  const signature = signPayload(rawSecret, body);

  for (let attempt = 0; attempt <= RETRY_DELAYS_SEC.length; attempt++) {
    if (attempt > 0) {
      const delaySec = RETRY_DELAYS_SEC[attempt - 1] ?? 16;
      await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    }

    try {
      const res = await fetch(agent.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DocVault-Signature': signature,
          'X-DocVault-Event': payload.event,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (res.ok) return;
      console.warn(
        `Webhook delivery failed for agent ${agent.id}: HTTP ${res.status} (attempt ${attempt + 1})`
      );
    } catch (err) {
      console.warn(
        `Webhook delivery error for agent ${agent.id} (attempt ${attempt + 1}):`,
        err
      );
    }
  }

  console.error(
    `Webhook delivery permanently failed for agent ${agent.id} after ${RETRY_DELAYS_SEC.length + 1} attempts`
  );
}

export async function dispatchWebhookToUrl(
  url: string,
  payload: WebhookPayload
): Promise<void> {
  const validation = validateWebhookUrl(url);
  if (!validation.valid) {
    console.warn(`dispatchWebhookToUrl: blocked URL "${url}" — ${validation.reason}`);
    return;
  }

  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt <= RETRY_DELAYS_SEC.length; attempt++) {
    if (attempt > 0) {
      const delaySec = RETRY_DELAYS_SEC[attempt - 1] ?? 16;
      await new Promise((resolve) => setTimeout(resolve, delaySec * 1000));
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
    } catch {
      // continue retrying
    }
  }
}
