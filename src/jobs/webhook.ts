import type PgBoss from 'pg-boss';
import type { Agent } from '../db/schema.js';
import { dispatchWebhook, dispatchWebhookToUrl } from '../api/lib/webhook.js';
import type { WebhookPayload } from '../api/lib/webhook.js';

export interface WebhookJobPayload {
  agentId: string;
  webhookUrl: string;
  webhookSecretEnc?: string;
  payload: WebhookPayload;
  attempt?: number;
}

export async function enqueueWebhook(
  boss: PgBoss,
  data: WebhookJobPayload
): Promise<void> {
  await boss.send('notify-webhook', data, {
    expireInSeconds: 300,
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
  });
}

export async function registerWebhookWorker(
  boss: PgBoss,
  getAgent: (id: string) => Promise<Agent | null>
): Promise<void> {
  await boss.work<WebhookJobPayload>(
    'notify-webhook',
    async (jobs: PgBoss.Job<WebhookJobPayload>[]) => {
      for (const job of jobs) {
        const { agentId, webhookUrl, payload } = job.data;
        const agent = await getAgent(agentId);
        if (agent) {
          await dispatchWebhook(agent, payload);
        } else if (webhookUrl.startsWith('http')) {
          await dispatchWebhookToUrl(webhookUrl, payload);
        }
      }
    }
  );
}
