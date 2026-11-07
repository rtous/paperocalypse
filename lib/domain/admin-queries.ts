import { and, asc, count, desc, eq, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import { events, flags, operators, poolTasks, reviewAssignments, submissions } from "@/lib/db/schema";
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
      .select({ ...base, since: reviewAssignments.dueAt, reviewer: operators.name })
      .from(reviewAssignments)
      .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
      .innerJoin(operators, eq(operators.id, reviewAssignments.reviewerOperatorId))
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
  const editor = sql<string | null>`(select name from operators where operators.id = ${submissions.handlingEditorId})`;
  return db
    .select({
      id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      submitter: operators.name,
      editor,
      versionNo: submissions.currentVersionNo,
      createdAt: submissions.createdAt,
      updatedAt: submissions.updatedAt,
    })
    .from(submissions)
    .innerJoin(operators, eq(operators.id, submissions.submittingOperatorId))
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

/** Operators by name, email or id (admin search). */
export async function searchOperators(db: Db, q: string | undefined, limit = 200) {
  const term = q?.trim();
  const like = term ? `%${term.replace(/[%_\\]/g, "\\$&")}%` : null;
  return db
    .select()
    .from(operators)
    .where(like ? or(ilike(operators.name, like), ilike(operators.email, like), sql`${operators.id}::text = ${term}`) : undefined)
    .orderBy(desc(operators.createdAt))
    .limit(limit);
}
