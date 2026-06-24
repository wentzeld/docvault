import type PgBoss from 'pg-boss';
import { config } from '../config.js';

export interface EmbedJobPayload {
  docId: string;
}

export async function enqueueEmbed(
  boss: PgBoss,
  docId: string
): Promise<void> {
  await boss.send(
    'embed-document',
    { docId } satisfies EmbedJobPayload,
    {
      expireInSeconds: config.jobs.expireInSeconds,
    }
  );
}
