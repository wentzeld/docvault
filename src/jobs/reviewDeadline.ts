import type PgBoss from 'pg-boss';
import { sql, and, eq, isNotNull, lte } from 'drizzle-orm';
import { reviews, documents, agents } from '../db/schema.js';
import type { DbClient } from '../db/index.js';
import { dispatchWebhook, dispatchWebhookToUrl } from '../api/lib/webhook.js';

/**
 * Runs on a schedule to auto-skip overdue review assignments.
 * Fires notify_on_complete if all reviewers are now done.
 */
export async function scheduleReviewDeadlineChecker(
  boss: PgBoss,
  db: DbClient
): Promise<void> {
  // Run every 60 seconds
  await boss.schedule('check-review-deadlines', '*/1 * * * *', {});

  await boss.work('check-review-deadlines', async (_job) => {
    await runDeadlineCheck(db);
  });
}

export async function runDeadlineCheck(db: DbClient): Promise<void> {
  // Find overdue reviews
  const overdue = await db
    .select()
    .from(reviews)
    .where(
      and(
        sql`${reviews.status} IN ('pending', 'in_progress')`,
        isNotNull(reviews.deadline),
        lte(reviews.deadline, sql`now()`)
      )
    );

  if (overdue.length === 0) return;

  for (const review of overdue) {
    console.warn(
      `Review deadline passed for doc=${review.doc_id} reviewer=${review.reviewer} round=${review.round} — auto-skipping`
    );

    await db
      .update(reviews)
      .set({
        status: 'skipped',
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(reviews.id, review.id));
  }

  // For each affected doc, check if all reviews are now done
  const affectedDocIds = [...new Set(overdue.map((r) => r.doc_id))];

  for (const docId of affectedDocIds) {
    const allReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.doc_id, docId));

    const allDone = allReviews.every(
      (r) => r.status === 'complete' || r.status === 'skipped'
    );

    if (!allDone) continue;

    // Transition document to synthesizing
    await db
      .update(documents)
      .set({ workflow_status: 'synthesizing', updated_at: new Date() })
      .where(eq(documents.id, docId));

    const notifyTarget = allReviews[0]?.notify_agent;
    if (!notifyTarget) continue;

    const commentCount = await db.execute(
      sql`SELECT COUNT(*) as count FROM comments WHERE doc_id = ${docId} AND deleted_at IS NULL`
    );
    const rows = commentCount.rows as Array<{ count: string }>;
    const totalComments = parseInt(rows[0]?.count ?? '0', 10);

    const payload = {
      event: 'review.complete',
      document_id: docId,
      review_summary: {
        total: allReviews.length,
        complete: allReviews.filter((r) => r.status === 'complete').length,
        comment_count: totalComments,
      },
      ts: new Date().toISOString(),
    };

    // Dispatch notification
    const agentRows = await db
      .select()
      .from(agents)
      .where(eq(agents.id, notifyTarget))
      .limit(1);

    const agent = agentRows[0];
    if (agent?.webhook_url) {
      dispatchWebhook(agent, payload).catch((err) =>
        console.warn('review.complete webhook failed:', err)
      );
    } else if (notifyTarget.startsWith('http')) {
      dispatchWebhookToUrl(notifyTarget, payload).catch((err) =>
        console.warn('review.complete direct webhook failed:', err)
      );
    }
  }
}
