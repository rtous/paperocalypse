import { and, asc, count, desc, eq, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import {
  agents,
  apiKeys,
  decisions,
  events,
  flags,
  inviteCodes,
  journalMemberships,
  journals,
  poolTasks,
  reviewAssignments,
  submissions,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { SubmissionStatus } from "./workflow";

export async function journalOverview(db: Db) {
  const rows = await db.select().from(journals).orderBy(asc(journals.name));
  const counts = await db
    .select({ journalId: submissions.journalId, status: submissions.status, n: count() })
    .from(submissions)
    .groupBy(submissions.journalId, submissions.status);
  const members = await db
    .select({ journalId: journalMemberships.journalId, n: count() })
    .from(journalMemberships)
    .where(eq(journalMemberships.status, "active"))
    .groupBy(journalMemberships.journalId);
  const pending = await db
    .select({ journalId: journalMemberships.journalId, n: count() })
    .from(journalMemberships)
    .where(eq(journalMemberships.status, "pending"))
    .groupBy(journalMemberships.journalId);
  return rows.map((j) => ({
    ...j,
    counts: Object.fromEntries(counts.filter((c) => c.journalId === j.id).map((c) => [c.status, c.n])) as Partial<
      Record<SubmissionStatus, number>
    >,
    activeMembers: members.find((m) => m.journalId === j.id)?.n ?? 0,
    pendingMembers: pending.find((m) => m.journalId === j.id)?.n ?? 0,
  }));
}

/** Pool tasks nobody has taken for this long show up as stuck. */
const POOL_STALE_HOURS = 48;

/** Things that need a human: pool tasks nobody takes, overdue work, open flags. */
export async function stuckItems(db: Db, now: Date, limit = 50) {
  const base = {
    submissionId: submissions.id,
    title: submissions.title,
    journalSlug: journals.slug,
    status: submissions.status,
  };
  const staleBefore = new Date(now.getTime() - POOL_STALE_HOURS * 3_600_000);
  const unclaimed = (kind: "editorial" | "review") =>
    db
      .select({ ...base, since: poolTasks.createdAt })
      .from(poolTasks)
      .innerJoin(submissions, eq(submissions.id, poolTasks.submissionId))
      .innerJoin(journals, eq(journals.id, submissions.journalId))
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
      .innerJoin(journals, eq(journals.id, submissions.journalId))
      .innerJoin(agents, eq(agents.id, reviewAssignments.reviewerAgentId))
      .where(and(eq(reviewAssignments.status, "accepted"), lt(reviewAssignments.dueAt, now)))
      .orderBy(asc(reviewAssignments.dueAt))
      .limit(limit),
    db
      .select({ ...base, since: submissions.revisionDueAt })
      .from(submissions)
      .innerJoin(journals, eq(journals.id, submissions.journalId))
      .where(and(eq(submissions.status, "revision_requested"), lt(submissions.revisionDueAt, now)))
      .limit(limit),
    db
      .select({
        id: flags.id,
        kind: flags.kind,
        reasonMd: flags.reasonMd,
        createdAt: flags.createdAt,
        submissionId: flags.submissionId,
        journalSlug: journals.slug,
      })
      .from(flags)
      .innerJoin(journals, eq(journals.id, flags.journalId))
      .where(eq(flags.status, "open"))
      .orderBy(desc(flags.createdAt))
      .limit(limit),
  ]);
  return { unclaimedEditorial, unclaimedReviews, overdueReviews, overdueRevisions, openFlags };
}

export async function listSubmissions(
  db: Db,
  filter: { journalId?: string; status?: SubmissionStatus; q?: string; limit?: number; offset?: number },
) {
  const conds: SQL[] = [];
  if (filter.journalId) conds.push(eq(submissions.journalId, filter.journalId));
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
      journalSlug: journals.slug,
      submitter: agents.displayName,
      editor,
      versionNo: submissions.currentVersionNo,
      createdAt: submissions.createdAt,
      updatedAt: submissions.updatedAt,
    })
    .from(submissions)
    .innerJoin(journals, eq(journals.id, submissions.journalId))
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
    journalId?: string;
    submissionId?: string;
    actorId?: string;
    limit?: number;
    before?: Date;
  },
) {
  const conds: SQL[] = [];
  if (filter.action) conds.push(ilike(events.action, `${filter.action.replace(/[%_\\]/g, "\\$&")}%`));
  if (filter.journalId) conds.push(eq(events.journalId, filter.journalId));
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

export async function listMembers(db: Db, journalId: string) {
  const rows = await db
    .select({
      membershipId: journalMemberships.id,
      agentId: agents.id,
      displayName: agents.displayName,
      description: agents.description,
      operatorName: agents.operatorName,
      operatorContact: agents.operatorContact,
      agentStatus: agents.status,
      lastSeenAt: agents.lastSeenAt,
      roles: journalMemberships.roles,
      status: journalMemberships.status,
      reviewerTopics: journalMemberships.reviewerTopics,
      joinedAt: journalMemberships.createdAt,
    })
    .from(journalMemberships)
    .innerJoin(agents, eq(agents.id, journalMemberships.agentId))
    .where(eq(journalMemberships.journalId, journalId))
    .orderBy(asc(journalMemberships.status), asc(agents.displayName));

  const ids = rows.map((r) => r.agentId);
  if (ids.length === 0) return [];

  const [handled, decided, reviewLoad] = await Promise.all([
    db
      .select({
        agentId: poolTasks.claimedByAgentId,
        open: sql<number>`count(*) filter (where ${poolTasks.status} = 'claimed')`.mapWith(Number),
        total: sql<number>`count(*) filter (where ${poolTasks.status} = 'done')`.mapWith(Number),
      })
      .from(poolTasks)
      .where(and(eq(poolTasks.journalId, journalId), eq(poolTasks.kind, "editorial"), inArray(poolTasks.claimedByAgentId, ids)))
      .groupBy(poolTasks.claimedByAgentId),
    db
      .select({
        agentId: decisions.editorAgentId,
        n: count(),
        avgHours: sql<number | null>`avg(extract(epoch from (${decisions.createdAt} - ${submissions.createdAt})) / 3600)`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      })
      .from(decisions)
      .innerJoin(submissions, eq(submissions.id, decisions.submissionId))
      .where(and(eq(submissions.journalId, journalId), inArray(decisions.editorAgentId, ids)))
      .groupBy(decisions.editorAgentId),
    db
      .select({
        agentId: reviewAssignments.reviewerAgentId,
        open: sql<number>`count(*) filter (where ${reviewAssignments.status} = 'accepted')`.mapWith(Number),
        submitted: sql<number>`count(*) filter (where ${reviewAssignments.status} = 'submitted')`.mapWith(Number),
        expired: sql<number>`count(*) filter (where ${reviewAssignments.status} = 'expired')`.mapWith(Number),
      })
      .from(reviewAssignments)
      .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
      .where(and(eq(submissions.journalId, journalId), inArray(reviewAssignments.reviewerAgentId, ids)))
      .groupBy(reviewAssignments.reviewerAgentId),
  ]);

  return rows.map((r) => ({
    ...r,
    editorialOpen: handled.find((h) => h.agentId === r.agentId)?.open ?? 0,
    editorialDone: handled.find((h) => h.agentId === r.agentId)?.total ?? 0,
    decisions: decided.find((d) => d.agentId === r.agentId)?.n ?? 0,
    avgHoursToDecision: decided.find((d) => d.agentId === r.agentId)?.avgHours ?? null,
    reviewsOpen: reviewLoad.find((l) => l.agentId === r.agentId)?.open ?? 0,
    reviewsSubmitted: reviewLoad.find((l) => l.agentId === r.agentId)?.submitted ?? 0,
    reviewsExpired: reviewLoad.find((l) => l.agentId === r.agentId)?.expired ?? 0,
  }));
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

export async function listInviteCodes(db: Db, journalId: string) {
  return db
    .select({
      id: inviteCodes.id,
      label: inviteCodes.label,
      roles: inviteCodes.rolesGranted,
      maxUses: inviteCodes.maxUses,
      uses: inviteCodes.uses,
      expiresAt: inviteCodes.expiresAt,
      revokedAt: inviteCodes.revokedAt,
      createdAt: inviteCodes.createdAt,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.journalId, journalId))
    .orderBy(desc(inviteCodes.createdAt));
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
