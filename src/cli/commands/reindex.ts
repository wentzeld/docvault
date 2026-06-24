import { Command } from 'commander';
import { isNull, eq, sql } from 'drizzle-orm';
import { documents } from '../../db/schema.js';
import { connectDb } from '../lib/db-connect.js';
import PgBoss from 'pg-boss';
import { config } from '../../config.js';

export function reindexCommand(): Command {
  const cmd = new Command('reindex').description(
    'Re-queue all documents for embedding (use after model change)'
  );

  cmd
    .option('--failed-only', 'Only re-queue documents with embed_status=failed')
    .option('--dry-run', 'Show what would be queued without queuing')
    .action(async (opts: { failedOnly?: boolean; dryRun?: boolean }) => {
      const { db, pool } = await connectDb();

      try {
        const conditions = [isNull(documents.deleted_at)];
        if (opts.failedOnly) {
          conditions.push(eq(documents.embed_status, 'failed'));
        }

        const docs = await db
          .select({ id: documents.id, title: documents.title })
          .from(documents)
          .where(sql`${documents.deleted_at} IS NULL AND (${opts.failedOnly ? sql`${documents.embed_status} = 'failed'` : sql`TRUE`})`);

        console.log(
          `Found ${docs.length} document(s) to re-queue for embedding.`
        );

        if (opts.dryRun) {
          for (const doc of docs) {
            console.log(`  [dry-run] Would queue: ${doc.id} — ${doc.title}`);
          }
          return;
        }

        // Connect to pg-boss
        const boss = new PgBoss({
          connectionString: config.database.url,
        });
        await boss.start();

        let queued = 0;
        for (const doc of docs) {
          try {
            // Reset embed_status to pending
            await db
              .update(documents)
              .set({ embed_status: 'pending', embed_model: null })
              .where(eq(documents.id, doc.id));

            await boss.send(
              'embed-document',
              { docId: doc.id },
              { expireInSeconds: config.jobs.expireInSeconds }
            );
            queued++;
            process.stdout.write(`\rQueued ${queued}/${docs.length}...`);
          } catch (err) {
            console.error(`\nFailed to queue doc ${doc.id}:`, err);
          }
        }

        await boss.stop();
        console.log(`\nQueued ${queued} documents for embedding.`);
      } finally {
        await pool.end();
      }
      process.exit(0);
    });

  return cmd;
}
