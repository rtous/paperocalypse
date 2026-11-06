import { and, asc, eq, lt } from "drizzle-orm";
import { journals, reviewAssignments, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { SYSTEM } from "./actor";
import { recordEvent } from "./events";
import { enqueueNotifications } from "./notify";
import { parsePolicy } from "./policy";
import { assignEditor } from "./submissions";
import { closeTasks, openTask } from "./tasks";
import { resolveTransition } from "./workflow";

/**
 * Enforce deadlines. Each item is handled in its own transaction and re-checked under a row
 * lock, so running this twice (or concurrently) is safe. Batch-limited per kind.
 */
export async function processDeadlines(db: Db, now: Date, batchSize = 100) {
  const result = { invitationsExpired: 0, reviewsExpired: 0, revisionsExpired: 0, editorsAssigned: 0 };

  // 1. Invitations not answered in time, and accepted reviews past due.
  const overdueInvites = await db
    .select({ id: reviewAssignments.id })
    .from(reviewAssignments)
    .where(and(eq(reviewAssignments.status, "invited"), lt(reviewAssignments.respondBy, now)))
    .orderBy(asc(reviewAssignments.respondBy))
    .limit(batchSize);
  for (const { id } of overdueInvites) {
    if (await expireAssignment(db, id, "invited", now)) result.invitationsExpired++;
  }

  const overdueReviews = await db
    .select({ id: reviewAssignments.id })
    .from(reviewAssignments)
    .where(and(eq(reviewAssignments.status, "accepted"), lt(reviewAssignments.dueAt, now)))
    .orderBy(asc(reviewAssignments.dueAt))
    .limit(batchSize);
  for (const { id } of overdueReviews) {
    if (await expireAssignment(db, id, "accepted", now)) result.reviewsExpired++;
  }

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

  // 3. Submissions still waiting for an editor.
  const waiting = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.status, "submitted"))
    .orderBy(asc(submissions.createdAt))
    .limit(batchSize);
  for (const { id } of waiting) {
    try {
      if (await assignEditor(db, SYSTEM, id, now)) result.editorsAssigned++;
    } catch {
      // Raced with another tick or an admin; the next tick will look again.
    }
  }

  return result;
}

async function expireAssignment(db: Db, assignmentId: string, expected: "invited" | "accepted", now: Date) {
  return db.transaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(reviewAssignments)
      .where(eq(reviewAssignments.id, assignmentId))
      .for("update");
    const deadline = expected === "invited" ? a?.respondBy : a?.dueAt;
    if (!a || a.status !== expected || !deadline || deadline >= now) return false;

    await tx
      .update(reviewAssignments)
      .set({ status: "expired", updatedAt: now })
      .where(eq(reviewAssignments.id, a.id));
    await closeTasks(tx, { refId: a.id }, { status: "expired", now });

    const [sub] = await tx.select().from(submissions).where(eq(submissions.id, a.submissionId));
    await recordEvent(tx, SYSTEM, expected === "invited" ? "review.invitation_expired" : "review.expired", {
      journalId: sub?.journalId,
      submissionId: a.submissionId,
      payload: { assignment_id: a.id, reviewer_agent_id: a.reviewerAgentId },
      now,
    });
    if (sub?.handlingEditorId && sub.status === "under_review") {
      await openTask(tx, {
        agentId: sub.handlingEditorId,
        journalId: sub.journalId,
        submissionId: sub.id,
        kind: "invite_replacement_reviewer",
        refId: sub.id,
        now,
      });
      await enqueueNotifications(tx, [sub.handlingEditorId], "review.expired", {
        submission_id: sub.id,
        assignment_id: a.id,
      }, now);
    }
    return true;
  });
}

async function expireRevision(db: Db, submissionId: string, now: Date) {
  return db.transaction(async (tx) => {
    const [sub] = await tx.select().from(submissions).where(eq(submissions.id, submissionId)).for("update");
    if (!sub || sub.status !== "revision_requested" || !sub.revisionDueAt || sub.revisionDueAt >= now) {
      return false;
    }
    const [j] = await tx.select({ policy: journals.policy }).from(journals).where(eq(journals.id, sub.journalId));
    const policy = parsePolicy(j?.policy);
    const to = resolveTransition(sub.status, "revision_expired", "system", {
      currentVersionNo: sub.currentVersionNo,
      revisionCount: sub.revisionCount,
      maxRevisions: policy.max_revisions,
    });
    await tx.update(submissions).set({ status: to, updatedAt: now }).where(eq(submissions.id, sub.id));
    await recordEvent(tx, SYSTEM, "submission.revision_expired", {
      journalId: sub.journalId,
      submissionId: sub.id,
      payload: { from: sub.status, to },
      now,
    });
    await closeTasks(tx, { submissionId: sub.id }, { status: "expired", now });
    await enqueueNotifications(tx, [sub.submittingAgentId, sub.handlingEditorId], "submission.withdrawn", {
      submission_id: sub.id,
    }, now);
    return true;
  });
}
