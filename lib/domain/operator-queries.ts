import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles,
  operators,
  papercoinTransactions,
  poolTasks,
  reviewAssignments,
  reviews,
  submissionAuthors,
  submissions,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { listInbox } from "./pool";

/**
 * Read models for the operator dashboard, scoped to the signed-in operator. They show what the
 * operator can see over MCP (author view, own reviews, handled submissions): never other
 * reviewers' identities.
 */

/** What the operator must do now (held pool task, revisions), earliest deadline first. */
export async function operatorTasks(db: Db, operatorId: string, limit = 100) {
  const inbox = await listInbox(db, operatorId);
  return inbox.slice(0, limit).map((t) => ({
    taskId: t.task_id,
    kind: t.kind,
    dueAt: t.due_at,
    submissionTitle: t.submission_title,
    summary: t.instructions,
  }));
}

/** Submissions the operator co-authored. */
export async function operatorSubmissions(db: Db, operatorId: string, limit = 100) {
  const subIds = (
    await db.selectDistinct({ id: submissionAuthors.submissionId }).from(submissionAuthors).where(eq(submissionAuthors.operatorId, operatorId))
  ).map((r) => r.id);
  if (subIds.length === 0) return [];
  const submitter = alias(operators, "submitter");
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      decision: submissions.decision,
      versionNo: submissions.currentVersionNo,
      revisionDueAt: submissions.revisionDueAt,
      updatedAt: submissions.updatedAt,
      createdAt: submissions.createdAt,
      submitter: submitter.name,
      articleNo: articles.articleNo,
    })
    .from(submissions)
    .innerJoin(submitter, eq(submitter.id, submissions.submittingOperatorId))
    .leftJoin(articles, eq(articles.submissionId, submissions.id))
    .where(inArray(submissions.id, subIds))
    .orderBy(desc(submissions.updatedAt))
    .limit(limit);
}

/** The operator's review assignments (their own reviews only). */
export async function operatorReviews(db: Db, operatorId: string, limit = 100) {
  return db
    .select({
      assignmentId: reviewAssignments.id,
      status: reviewAssignments.status,
      versionNo: reviewAssignments.versionNo,
      claimedAt: reviewAssignments.claimedAt,
      dueAt: reviewAssignments.dueAt,
      submittedAt: reviewAssignments.submittedAt,
      recommendation: reviews.recommendation,
      submissionTitle: submissions.title,
      submissionStatus: submissions.status,
    })
    .from(reviewAssignments)
    .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
    .leftJoin(reviews, eq(reviews.assignmentId, reviewAssignments.id))
    .where(eq(reviewAssignments.reviewerOperatorId, operatorId))
    .orderBy(desc(reviewAssignments.claimedAt))
    .limit(limit);
}

/** Editorial tasks the operator holds or has done. */
export async function operatorEditorial(db: Db, operatorId: string, limit = 100) {
  return db
    .select({
      id: poolTasks.id,
      submissionId: submissions.id,
      title: submissions.title,
      taskStatus: poolTasks.status,
      submissionStatus: submissions.status,
      versionNo: poolTasks.versionNo,
      dueAt: poolTasks.dueAt,
      updatedAt: poolTasks.updatedAt,
    })
    .from(poolTasks)
    .innerJoin(submissions, eq(submissions.id, poolTasks.submissionId))
    .where(and(eq(poolTasks.claimedByOperatorId, operatorId), eq(poolTasks.kind, "editorial"), inArray(poolTasks.status, ["claimed", "done"])))
    .orderBy(desc(poolTasks.updatedAt))
    .limit(limit);
}

/** The operator's wallet history, newest first. */
export async function operatorPapercoinHistory(db: Db, operatorId: string, limit = 50) {
  return db
    .select({
      amount: papercoinTransactions.amount,
      reason: papercoinTransactions.reason,
      balanceAfter: papercoinTransactions.balanceAfter,
      note: papercoinTransactions.note,
      at: papercoinTransactions.createdAt,
    })
    .from(papercoinTransactions)
    .where(eq(papercoinTransactions.operatorId, operatorId))
    .orderBy(desc(papercoinTransactions.createdAt), desc(papercoinTransactions.id))
    .limit(limit);
}

/** True if the operator is an author of the submission. */
export async function operatorAuthorsSubmission(db: Db, operatorId: string, submissionId: string) {
  const [row] = await db
    .select({ id: submissionAuthors.id })
    .from(submissionAuthors)
    .where(and(eq(submissionAuthors.submissionId, submissionId), eq(submissionAuthors.operatorId, operatorId)))
    .limit(1);
  return !!row;
}
