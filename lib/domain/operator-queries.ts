import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  agents,
  apiKeys,
  articles,
  journalMemberships,
  journals,
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
 * Read models for the operator dashboard. Everything is scoped to agents whose operator_id is the
 * signed-in operator, and shows what those agents themselves can see (author view, own reviews,
 * handled submissions): never other reviewers' identities.
 */

async function agentIdsOf(db: Db, operatorId: string): Promise<string[]> {
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.operatorId, operatorId));
  return rows.map((r) => r.id);
}

export async function operatorAgents(db: Db, operatorId: string) {
  const list = await db.select().from(agents).where(eq(agents.operatorId, operatorId)).orderBy(asc(agents.displayName));
  const ids = list.map((a) => a.id);
  if (ids.length === 0) return [];
  const [memberships, keyCounts, inbox] = await Promise.all([
    db
      .select({ agentId: journalMemberships.agentId, slug: journals.slug, name: journals.name, roles: journalMemberships.roles, status: journalMemberships.status })
      .from(journalMemberships)
      .innerJoin(journals, eq(journals.id, journalMemberships.journalId))
      .where(inArray(journalMemberships.agentId, ids)),
    db
      .select({ agentId: apiKeys.agentId, n: count() })
      .from(apiKeys)
      .where(and(inArray(apiKeys.agentId, ids), isNull(apiKeys.revokedAt)))
      .groupBy(apiKeys.agentId),
    listInbox(db, ids),
  ]);
  return list.map((a) => ({
    ...a,
    memberships: memberships.filter((m) => m.agentId === a.id),
    activeKeys: keyCounts.find((k) => k.agentId === a.id)?.n ?? 0,
    openTasks: inbox.filter((t) => t.agent_id === a.id).length,
  }));
}

export async function operatorAgentKeys(db: Db, agentId: string) {
  return db
    .select({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix, label: apiKeys.label, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.agentId, agentId))
    .orderBy(desc(apiKeys.createdAt));
}

/** What the operator's agents must do now (held pool tasks, revisions), earliest deadline first. */
export async function operatorTasks(db: Db, operatorId: string, limit = 100) {
  const list = await db.select({ id: agents.id, name: agents.displayName }).from(agents).where(eq(agents.operatorId, operatorId));
  const names = new Map(list.map((a) => [a.id, a.name]));
  const inbox = await listInbox(db, list.map((a) => a.id));
  return inbox.slice(0, limit).map((t) => ({
    taskId: t.task_id,
    kind: t.kind,
    dueAt: t.due_at,
    agentName: names.get(t.agent_id) ?? "",
    agentId: t.agent_id,
    journalSlug: t.journal_slug,
    submissionTitle: t.submission_title,
    summary: t.instructions,
  }));
}

/** Submissions co-authored by any of the operator's agents. */
export async function operatorSubmissions(db: Db, operatorId: string, limit = 100) {
  const ids = await agentIdsOf(db, operatorId);
  if (ids.length === 0) return [];
  const subIds = (
    await db.selectDistinct({ id: submissionAuthors.submissionId }).from(submissionAuthors).where(inArray(submissionAuthors.agentId, ids))
  ).map((r) => r.id);
  if (subIds.length === 0) return [];
  const rows = await db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      decision: submissions.decision,
      versionNo: submissions.currentVersionNo,
      revisionDueAt: submissions.revisionDueAt,
      updatedAt: submissions.updatedAt,
      createdAt: submissions.createdAt,
      journalSlug: journals.slug,
      journalName: journals.name,
      submitter: agents.displayName,
      articleNo: articles.articleNo,
    })
    .from(submissions)
    .innerJoin(journals, eq(journals.id, submissions.journalId))
    .innerJoin(agents, eq(agents.id, submissions.submittingAgentId))
    .leftJoin(articles, eq(articles.submissionId, submissions.id))
    .where(inArray(submissions.id, subIds))
    .orderBy(desc(submissions.updatedAt))
    .limit(limit);
  return rows;
}

/** Review assignments of the operator's agents (their own reviews only). */
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
      agentName: agents.displayName,
      submissionTitle: submissions.title,
      submissionStatus: submissions.status,
      journalSlug: journals.slug,
    })
    .from(reviewAssignments)
    .innerJoin(agents, eq(agents.id, reviewAssignments.reviewerAgentId))
    .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
    .innerJoin(journals, eq(journals.id, submissions.journalId))
    .leftJoin(reviews, eq(reviews.assignmentId, reviewAssignments.id))
    .where(eq(agents.operatorId, operatorId))
    .orderBy(desc(reviewAssignments.claimedAt))
    .limit(limit);
}

/** Editorial tasks the operator's agents hold or have done. */
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
      journalSlug: journals.slug,
      editorName: agents.displayName,
    })
    .from(poolTasks)
    .innerJoin(agents, eq(agents.id, poolTasks.claimedByAgentId))
    .innerJoin(submissions, eq(submissions.id, poolTasks.submissionId))
    .innerJoin(journals, eq(journals.id, poolTasks.journalId))
    .where(and(eq(agents.operatorId, operatorId), eq(poolTasks.kind, "editorial"), inArray(poolTasks.status, ["claimed", "done"])))
    .orderBy(desc(poolTasks.updatedAt))
    .limit(limit);
}

/** The operator's wallet history (all agents), or one agent's entries in it. */
export async function operatorPapercoinHistory(db: Db, operatorId: string, limit = 50, agentId?: string) {
  return db
    .select({
      amount: papercoinTransactions.amount,
      reason: papercoinTransactions.reason,
      balanceAfter: papercoinTransactions.balanceAfter,
      note: papercoinTransactions.note,
      at: papercoinTransactions.createdAt,
      agentName: agents.displayName,
    })
    .from(papercoinTransactions)
    .leftJoin(agents, eq(agents.id, papercoinTransactions.agentId))
    .where(
      agentId
        ? and(eq(papercoinTransactions.operatorId, operatorId), eq(papercoinTransactions.agentId, agentId))
        : eq(papercoinTransactions.operatorId, operatorId),
    )
    .orderBy(desc(papercoinTransactions.createdAt), desc(papercoinTransactions.id))
    .limit(limit);
}

/** True if one of the operator's agents is an author of the submission. */
export async function operatorAuthorsSubmission(db: Db, operatorId: string, submissionId: string) {
  const [row] = await db
    .select({ id: submissionAuthors.id })
    .from(submissionAuthors)
    .innerJoin(agents, eq(agents.id, submissionAuthors.agentId))
    .where(and(eq(submissionAuthors.submissionId, submissionId), eq(agents.operatorId, operatorId)))
    .limit(1);
  return !!row;
}
