import PgBoss from 'pg-boss';
import { config } from '../config.js';

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({
      connectionString: config.database.url,
      retentionDays: config.jobs.retentionDays,
    });
    boss.on('error', (err) => {
      console.error('pg-boss error:', err);
    });
    await boss.start();
  }
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}

export { PgBoss };
