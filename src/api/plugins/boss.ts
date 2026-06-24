import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import PgBoss from 'pg-boss';
import { config } from '../../config.js';

async function bossPlugin(fastify: FastifyInstance): Promise<void> {
  const boss = new PgBoss({
    connectionString: config.database.url,
    retentionDays: config.jobs.retentionDays,
  });

  boss.on('error', (err) => {
    fastify.log.error({ err }, 'pg-boss error');
  });

  await boss.start();

  // pg-boss v10 requires queues to exist before send/schedule/work.
  // createQueue is idempotent — safe to call on every startup.
  for (const queueName of ['embed-document', 'notify-webhook', 'check-review-deadlines']) {
    await boss.createQueue(queueName);
  }

  // ── notify-webhook worker ──────────────────────────────────────────────────
  // Forwards approval/comment events to an external notify endpoint of your
  // choosing (e.g. a bot orchestrator that routes them to the creating agent).
  // Configure the destination with DOCVAULT_NOTIFY_WEBHOOK_URL. If it is unset,
  // notifications are skipped (jobs complete as no-ops). When
  // DOCVAULT_NOTIFY_WEBHOOK_TOKEN is set it is sent as a Bearer credential so the
  // receiver can authenticate the delivery.
  const NOTIFY_WEBHOOK_URL = process.env.DOCVAULT_NOTIFY_WEBHOOK_URL || '';
  const NOTIFY_TOKEN = process.env.DOCVAULT_NOTIFY_WEBHOOK_TOKEN || '';

  boss.work('notify-webhook', async ([job]) => {
    if (!job) return;
    if (!NOTIFY_WEBHOOK_URL) return; // no destination configured — nothing to do
    try {
      const res = await fetch(NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(NOTIFY_TOKEN ? { Authorization: `Bearer ${NOTIFY_TOKEN}` } : {}),
        },
        body: JSON.stringify(job.data),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        fastify.log.warn({ status: res.status }, 'notify-webhook: receiver returned non-OK');
      }
    } catch (err) {
      fastify.log.warn({ err }, 'notify-webhook: delivery failed — pg-boss will retry');
      throw err; // triggers pg-boss retry
    }
  });

  fastify.decorate('boss', boss);

  fastify.addHook('onClose', async () => {
    await boss.stop();
  });
}

export default fp(bossPlugin, { name: 'boss' });
