import { and, asc, eq, lt } from "drizzle-orm";
import { submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { SYSTEM } from "./actor";
import { recordEvent } from "./events";
import { enqueueNotifications } from "./notify";
import { getPolicy } from "./settings";
import { expireClaims } from "./pool";
import { publishArticle } from "./submissions";
import { resolveTransition } from "./workflow";

/**
 * Enforce deadlines. Each item is handled in its own transaction and re-checked under a row
 * lock, so running this twice (or concurrently) is safe. Batch-limited per kind.
 */
export async function processDeadlines(db: Db, now: Date, batchSize = 100) {
  const result = { claimsExpired: 0, revisionsExpired: 0, published: 0 };

  // 1. Pool tasks held past their due_at go back to the pool.
  result.claimsExpired = await expireClaims(db, now, batchSize);

  // 2. Revisions past their deadline are withdrawn.
  const overdueRevisions = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.status, "revision_requested"), lt(submissions.revisionDueAt, now)))
    .orderBy(asc(submissions.revisionDueAt))
    .limit(batchSize);
  for (const { id } of overdueRevisions) {
    if (await expireRevision(db, id, now)) result.revisionsExpired++;
  }

  // 3. Accepted submissions are normally published on acceptance; publish any left behind.
  const accepted = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.status, "accepted"))
    .orderBy(asc(submissions.updatedAt))
    .limit(batchSize);
  for (const { id } of accepted) {
    try {
      await publishArticle(db, SYSTEM, id, now);
      result.published++;
    } catch {
      // Raced with an admin; the next tick will look again.
    }
  }

  return result;
}

async function expireRevision(db: Db, submissionId: string, now: Date) {
  return db.transaction(async (tx) => {
    const [sub] = await tx.select().from(submissions).where(eq(submissions.id, submissionId)).for("update");
    if (!sub || sub.status !== "revision_requested" || !sub.revisionDueAt || sub.revisionDueAt >= now) {
      return false;
    }
    const policy = await getPolicy(tx);
    const to = resolveTransition(sub.status, "revision_expired", "system", {
      currentVersionNo: sub.currentVersionNo,
      revisionCount: sub.revisionCount,
      maxRevisions: policy.max_revisions,
    });
    await tx.update(submissions).set({ status: to, updatedAt: now }).where(eq(submissions.id, sub.id));
    await recordEvent(tx, SYSTEM, "submission.revision_expired", {
      submissionId: sub.id,
      payload: { from: sub.status, to },
      now,
    });
    await enqueueNotifications(tx, [sub.submittingAgentId], "submission.withdrawn", { submission_id: sub.id }, now);
    return true;
  });
}
