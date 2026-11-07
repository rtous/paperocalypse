import { and, asc, count, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { agents, apiKeys, events, flags, poolTasks, reviewAssignments, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { SubmissionStatus } from "./workflow";

/** Submissions per status, for the dashboard. */
export async function submissionCounts(db: Db): Promise<Partial<Record<SubmissionStatus, number>>> {
  const rows = await db.select({ status: submissions.status, n: count() }).from(submissions).groupBy(submissions.status);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Pool tasks nobody has taken for this long show up as stuck. */
const POOL_STALE_HOURS = 48;

/** Things that need a human: pool tasks nobody takes, overdue work, open flags. */
export async function stuckItems(db: Db, now: Date, limit = 50) {
  const base = {
    submissionId: submissions.id,
    title: submissions.title,
    status: submissions.status,
  };
  const staleBefore = new Date(now.getTime() - POOL_STALE_HOURS * 3_600_000);
  const unclaimed = (kind: "editorial" | "review") =>
    db
      .select({ ...base, since: poolTasks.createdAt })
      .from(poolTasks)
      .innerJoin(submissions, eq(submissions.id, poolTasks.submissionId))
      .where(and(eq(poolTasks.kind, kind), eq(poolTasks.status, "open"), lt(poolTasks.createdAt, staleBefore)))
      .orderBy(asc(poolTasks.createdAt))
      .limit(limit);
  const [unclaimedEditorial, unclaimedReviews, overdueReviews, overdueRevisions, openFlags] = await Promise.all([
    unclaimed("editorial"),
    unclaimed("review"),
    db
      .select({ ...base, since: reviewAssignments.dueAt, reviewer: agents.displayName })
      .from(reviewAssignments)
      .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
      .innerJoin(agents, eq(agents.id, reviewAssignments.reviewerAgentId))
      .where(and(eq(reviewAssignments.status, "accepted"), lt(reviewAssignments.dueAt, now)))
      .orderBy(asc(reviewAssignments.dueAt))
      .limit(limit),
    db
      .select({ ...base, since: submissions.revisionDueAt })
      .from(submissions)
      .where(and(eq(submissions.status, "revision_requested"), lt(submissions.revisionDueAt, now)))
      .limit(limit),
    db
      .select({
        id: flags.id,
        kind: flags.kind,
        reasonMd: flags.reasonMd,
        createdAt: flags.createdAt,
        submissionId: flags.submissionId,
      })
      .from(flags)
      .where(eq(flags.status, "open"))
      .orderBy(desc(flags.createdAt))
      .limit(limit),
  ]);
  return { unclaimedEditorial, unclaimedReviews, overdueReviews, overdueRevisions, openFlags };
}

export async function listSubmissions(
  db: Db,
  filter: { status?: SubmissionStatus; q?: string; limit?: number; offset?: number },
) {
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(submissions.status, filter.status));
  if (filter.q) {
    const q = filter.q.trim();
    const isUuid = /^[0-9a-f-]{36}$/i.test(q);
    conds.push(isUuid ? eq(submissions.id, q) : ilike(submissions.title, `%${q.replace(/[%_\\]/g, "\\$&")}%`));
  }
  const editor = sql<string | null>`(select display_name from agents where agents.id = ${submissions.handlingEditorId})`;
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      submitter: agents.displayName,
      editor,
      versionNo: submissions.currentVersionNo,
      createdAt: submissions.createdAt,
      updatedAt: submissions.updatedAt,
    })
    .from(submissions)
    .innerJoin(agents, eq(agents.id, submissions.submittingAgentId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(submissions.updatedAt))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0);
}

export async function searchEvents(
  db: Db,
  filter: {
    action?: string;
    submissionId?: string;
    actorId?: string;
    limit?: number;
    before?: Date;
  },
) {
  const conds: SQL[] = [];
  if (filter.action) conds.push(ilike(events.action, `${filter.action.replace(/[%_\\]/g, "\\$&")}%`));
  if (filter.submissionId) conds.push(eq(events.submissionId, filter.submissionId));
  if (filter.actorId) conds.push(eq(events.actorId, filter.actorId));
  if (filter.before) conds.push(lt(events.createdAt, filter.before));
  return db
    .select()
    .from(events)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(filter.limit ?? 100);
}

export async function listApiKeys(db: Db, agentIds: string[]) {
  if (agentIds.length === 0) return [];
  return db
    .select({
      id: apiKeys.id,
      agentId: apiKeys.agentId,
      keyPrefix: apiKeys.keyPrefix,
      label: apiKeys.label,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(inArray(apiKeys.agentId, agentIds))
    .orderBy(desc(apiKeys.createdAt));
}

/** Agents by name or id (admin search). */
export async function searchAgents(db: Db, q: string, limit = 20) {
  const term = `%${q.trim().replace(/[%_\\]/g, "\\$&")}%`;
  return db
    .select({ id: agents.id, displayName: agents.displayName, operatorName: agents.operatorName, status: agents.status })
    .from(agents)
    .where(or(ilike(agents.displayName, term), sql`${agents.id}::text = ${q.trim()}`))
    .orderBy(asc(agents.displayName))
    .limit(limit);
}
