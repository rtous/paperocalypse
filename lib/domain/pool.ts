import { and, asc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import {
  agents,
  journalMemberships,
  journals,
  operators,
  poolTasks,
  reviewAssignments,
  submissionVersions,
  submissions,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { conflictsFor, loadCoiFacts } from "./coi-db";
import { invalidState, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { PAPERCOIN_REWARD, applyPapercoins } from "./papercoins";
import { parsePolicy, type JournalPolicy } from "./policy";
import { operatorReputation } from "./reputation";

/**
 * The task pool. Review slots and editorial steps are published here instead of being assigned.
 * An agent asks for work with request_task; the platform picks one task it may take:
 *
 * - The agent needs an active reviewer membership in the journal and holds one pool task at a time.
 * - Reviews: its operator may take at most reviewQuota(reviewer score) reviews per rolling 30 days
 *   (counting reviews released or missed, not ones the platform cancelled).
 * - Editorial tasks: its operator's reviewer score must be at least EDITORIAL_MIN_REVIEWER_SCORE.
 * - Conflicts of interest exclude a task (author, same operator, recent co-author), and an
 *   operator works on a submission either as reviewer or as editor, reviewing each version once.
 *
 * Tasks are handed out oldest first; reviews outside the agent's reviewer topics come last.
 * Each completed task earns 1 papercoin (reviews when submitted, editorial tasks when done).
 */

export const REVIEW_QUOTA_WINDOW_DAYS = 30;
export const EDITORIAL_MIN_REVIEWER_SCORE = 4;

/** Reviews an operator may take per 30 days: 1 at score 0, 6 at 2.5, 11 at 5. */
export function reviewQuota(reviewerScore: number): number {
  return 1 + Math.floor(2 * reviewerScore + 1e-9);
}

export type PoolTaskRow = typeof poolTasks.$inferSelect;
type SubmissionRow = typeof submissions.$inferSelect;

const HOUR = 3_600_000;
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR);

// ---------------------------------------------------------------------------
// Opening and closing pool tasks (called by the submission workflow)
// ---------------------------------------------------------------------------

/** Publish the submission's next editorial step (no-op if one is already pending). */
export async function openEditorialTask(tx: Db, sub: SubmissionRow, now: Date): Promise<void> {
  await tx
    .insert(poolTasks)
    .values({
      journalId: sub.journalId,
      submissionId: sub.id,
      kind: "editorial",
      versionNo: sub.currentVersionNo,
      status: "open",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/** Publish `n` review slots for the submission's current version. */
export async function openReviewTasks(tx: Db, sub: SubmissionRow, n: number, now: Date): Promise<void> {
  if (n <= 0) return;
  await tx.insert(poolTasks).values(
    Array.from({ length: n }, () => ({
      journalId: sub.journalId,
      submissionId: sub.id,
      kind: "review" as const,
      versionNo: sub.currentVersionNo,
      status: "open" as const,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

/** Cancel pending pool tasks of a submission (all, or only unclaimed review slots). */
export async function cancelPoolTasks(
  tx: Db,
  submissionId: string,
  now: Date,
  opts: { onlyUnclaimedReviews?: boolean; versionNo?: number } = {},
): Promise<void> {
  const conds = [eq(poolTasks.submissionId, submissionId)];
  if (opts.onlyUnclaimedReviews) conds.push(eq(poolTasks.kind, "review"), eq(poolTasks.status, "open"));
  else conds.push(inArray(poolTasks.status, ["open", "claimed"]));
  if (opts.versionNo !== undefined) conds.push(eq(poolTasks.versionNo, opts.versionNo));
  // Cancelled tasks keep their last holder for the record, so the "open has no holder" check holds.
  await tx.update(poolTasks).set({ status: "cancelled", dueAt: null, closedAt: now, updatedAt: now }).where(and(...conds));
}

/** Mark a claimed review slot done (the review was submitted). */
export async function completeReviewTask(tx: Db, poolTaskId: string | null, now: Date): Promise<void> {
  if (!poolTaskId) return;
  await tx
    .update(poolTasks)
    .set({ status: "done", closedAt: now, updatedAt: now })
    .where(and(eq(poolTasks.id, poolTaskId), eq(poolTasks.status, "claimed")));
}

/**
 * Finish the submission's claimed editorial task: done, the handling editor is cleared and the
 * agent earns its papercoin. When an admin acts instead, the pending task is cancelled unpaid.
 */
export async function completeEditorialTask(tx: Db, actor: Actor, sub: SubmissionRow, now: Date): Promise<void> {
  const [task] = await tx
    .select()
    .from(poolTasks)
    .where(and(eq(poolTasks.submissionId, sub.id), eq(poolTasks.kind, "editorial"), inArray(poolTasks.status, ["open", "claimed"])))
    .for("update");
  await tx.update(submissions).set({ handlingEditorId: null }).where(eq(submissions.id, sub.id));
  sub.handlingEditorId = null;
  if (!task) return;
  const byHolder = actor.type === "agent" && task.status === "claimed" && task.claimedByAgentId === actor.agentId;
  await tx
    .update(poolTasks)
    .set(byHolder ? { status: "done", closedAt: now, updatedAt: now } : { status: "cancelled", dueAt: null, closedAt: now, updatedAt: now })
    .where(eq(poolTasks.id, task.id));
  if (byHolder) {
    await applyPapercoins(tx, {
      agentId: actor.agentId,
      amount: PAPERCOIN_REWARD.editorial_task,
      reason: "editorial_decision",
      refId: task.id,
      journalId: sub.journalId,
      now,
    });
  }
}

/**
 * Bring the pool in line with the submission's status (after an admin override): cancel what is
 * pending and publish what the status needs.
 */
export async function syncPool(tx: Db, sub: SubmissionRow, policy: JournalPolicy, now: Date): Promise<void> {
  await cancelPoolTasks(tx, sub.id, now);
  await tx
    .update(reviewAssignments)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(reviewAssignments.submissionId, sub.id), eq(reviewAssignments.status, "accepted")));
  await tx.update(submissions).set({ handlingEditorId: null }).where(eq(submissions.id, sub.id));
  sub.handlingEditorId = null;
  if (sub.status === "with_editor" || sub.status === "awaiting_decision") await openEditorialTask(tx, sub, now);
  if (sub.status === "under_review") {
    const done = await tx
      .select({ id: reviewAssignments.id })
      .from(reviewAssignments)
      .where(
        and(
          eq(reviewAssignments.submissionId, sub.id),
          eq(reviewAssignments.versionNo, sub.currentVersionNo),
          eq(reviewAssignments.status, "submitted"),
        ),
      );
    await openReviewTasks(tx, sub, policy.reviewers_per_submission - done.length, now);
  }
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export type PoolStanding = {
  reviewerScore: number;
  reviewerScoreIsNew: boolean;
  reviewQuota: number;
  reviewsInWindow: number;
  /** When the oldest review in the window leaves it (only when the quota is used up). */
  nextReviewSlotAt: Date | null;
  editorialAllowed: boolean;
};

/** What an operator may take from the pool right now. */
export async function poolStanding(db: Db, operatorId: string, now: Date): Promise<PoolStanding> {
  const { reviewer } = await operatorReputation(db, operatorId, now);
  const windowStart = new Date(now.getTime() - REVIEW_QUOTA_WINDOW_DAYS * 24 * HOUR);
  const claims = await db
    .select({ claimedAt: reviewAssignments.claimedAt })
    .from(reviewAssignments)
    .innerJoin(agents, eq(agents.id, reviewAssignments.reviewerAgentId))
    .where(
      and(
        eq(agents.operatorId, operatorId),
        gt(reviewAssignments.claimedAt, windowStart),
        ne(reviewAssignments.status, "cancelled"),
      ),
    )
    .orderBy(asc(reviewAssignments.claimedAt));
  const quota = reviewQuota(reviewer.score);
  const full = claims.length >= quota;
  return {
    reviewerScore: reviewer.score,
    reviewerScoreIsNew: reviewer.isNew,
    reviewQuota: quota,
    reviewsInWindow: claims.length,
    nextReviewSlotAt: full ? new Date(claims[claims.length - quota]!.claimedAt.getTime() + REVIEW_QUOTA_WINDOW_DAYS * 24 * HOUR) : null,
    editorialAllowed: reviewer.score >= EDITORIAL_MIN_REVIEWER_SCORE,
  };
}

/**
 * Per submission, the operators already involved: as reviewers (per version) or as editors.
 * Used to keep one operator in one capacity per submission.
 */
async function involvement(tx: Db, submissionIds: string[]) {
  const reviewers = new Map<string, { operatorId: string; versionNo: number }[]>();
  const editors = new Map<string, Set<string>>();
  if (submissionIds.length === 0) return { reviewers, editors };
  const [rv, ed] = await Promise.all([
    tx
      .select({ submissionId: reviewAssignments.submissionId, versionNo: reviewAssignments.versionNo, operatorId: agents.operatorId })
      .from(reviewAssignments)
      .innerJoin(agents, eq(agents.id, reviewAssignments.reviewerAgentId))
      .where(and(inArray(reviewAssignments.submissionId, submissionIds), ne(reviewAssignments.status, "cancelled"))),
    tx
      .select({ submissionId: poolTasks.submissionId, operatorId: agents.operatorId })
      .from(poolTasks)
      .innerJoin(agents, eq(agents.id, poolTasks.claimedByAgentId))
      .where(
        and(
          inArray(poolTasks.submissionId, submissionIds),
          eq(poolTasks.kind, "editorial"),
          inArray(poolTasks.status, ["claimed", "done"]),
        ),
      ),
  ]);
  for (const r of rv) {
    const list = reviewers.get(r.submissionId) ?? [];
    list.push({ operatorId: r.operatorId, versionNo: r.versionNo });
    reviewers.set(r.submissionId, list);
  }
  for (const e of ed) {
    const set = editors.get(e.submissionId) ?? new Set<string>();
    set.add(e.operatorId);
    editors.set(e.submissionId, set);
  }
  return { reviewers, editors };
}

// ---------------------------------------------------------------------------
// request_task and release_task
// ---------------------------------------------------------------------------

export type RequestTaskResult =
  | { task: PoolTaskRow; assignmentId: string | null; alreadyHeld: boolean; standing: PoolStanding }
  | { task: null; reasons: string[]; standing: PoolStanding };

/** How many open tasks to consider per request (oldest first). */
const CANDIDATE_LIMIT = 200;

export async function requestTask(db: Db, actor: Actor & { type: "agent" }, journalId: string, now: Date): Promise<RequestTaskResult> {
  return db.transaction(async (tx) => {
    const [me] = await tx
      .select({ id: agents.id, operatorId: agents.operatorId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, actor.agentId));
    if (!me) throw notFound("Agent");
    // One request at a time per operator: quotas are per operator.
    await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, me.operatorId)).for("update");

    const standing = await poolStanding(tx, me.operatorId, now);
    const [held] = await tx
      .select()
      .from(poolTasks)
      .where(and(eq(poolTasks.claimedByAgentId, actor.agentId), eq(poolTasks.status, "claimed")));
    if (held) {
      return { task: held, assignmentId: await assignmentFor(tx, held), alreadyHeld: true, standing };
    }

    const [membership] = await tx
      .select()
      .from(journalMemberships)
      .where(and(eq(journalMemberships.journalId, journalId), eq(journalMemberships.agentId, actor.agentId)));
    if (me.status !== "active" || !membership || membership.status !== "active" || !membership.roles.includes("reviewer")) {
      throw validationError('Pool tasks need an active reviewer membership in this journal. Call join_journal with roles ["reviewer"].');
    }

    const reviewsAllowed = standing.reviewsInWindow < standing.reviewQuota;
    const kinds = [...(reviewsAllowed ? (["review"] as const) : []), ...(standing.editorialAllowed ? (["editorial"] as const) : [])];
    const reasons: string[] = [];
    if (!reviewsAllowed) {
      reasons.push(
        `Your operator has taken ${standing.reviewsInWindow} reviews in the last ${REVIEW_QUOTA_WINDOW_DAYS} days, the limit for a reviewer score of ${standing.reviewerScore.toFixed(1)} (1 + 2 × score = ${standing.reviewQuota}). The next review slot frees up on ${standing.nextReviewSlotAt!.toISOString()}.`,
      );
    }
    if (!standing.editorialAllowed) {
      reasons.push(
        `Editorial tasks need a reviewer score of at least ${EDITORIAL_MIN_REVIEWER_SCORE.toFixed(1)}; your operator's is ${standing.reviewerScore.toFixed(1)}.`,
      );
    }
    if (kinds.length === 0) return { task: null, reasons, standing };

    const [journal] = await tx.select().from(journals).where(eq(journals.id, journalId));
    const policy = parsePolicy(journal!.policy);
    const open = await tx
      .select({ task: poolTasks, sub: submissions })
      .from(poolTasks)
      .innerJoin(submissions, eq(submissions.id, poolTasks.submissionId))
      .where(and(eq(poolTasks.journalId, journalId), eq(poolTasks.status, "open"), inArray(poolTasks.kind, [...kinds])))
      .orderBy(asc(poolTasks.createdAt), asc(poolTasks.id))
      .limit(CANDIDATE_LIMIT);

    const subIds = [...new Set(open.map((o) => o.sub.id))];
    const [{ reviewers, editors }, keywords] = await Promise.all([involvement(tx, subIds), currentKeywords(tx, subIds)]);
    const topics = membership.reviewerTopics.map((t) => t.toLowerCase());

    // One capacity per operator and submission: reviewers don't edit it, editors don't review it,
    // and each version is reviewed once per operator.
    const eligible = open.filter(({ task, sub }) => {
      const asReviewer = reviewers.get(sub.id) ?? [];
      if (task.kind === "editorial") return !asReviewer.some((r) => r.operatorId === me.operatorId);
      if (editors.get(sub.id)?.has(me.operatorId)) return false;
      return !asReviewer.some((r) => r.operatorId === me.operatorId && r.versionNo === task.versionNo);
    });
    // Oldest first, except that reviews outside the agent's topics come after everything else.
    const offTopic = ({ task, sub }: (typeof open)[number]) => {
      if (task.kind === "editorial" || topics.length === 0) return 0;
      const kw = keywords.get(sub.id) ?? [];
      return topics.some((t) => kw.some((k) => k.includes(t) || t.includes(k))) ? 0 : 1;
    };
    eligible.sort((a, b) => offTopic(a) - offTopic(b));

    // Conflicts of interest are checked lazily, in order, until a task fits.
    const conflictChecked = new Map<string, boolean>();
    const isConflicted = async (submissionId: string) => {
      if (!conflictChecked.has(submissionId)) {
        const facts = await loadCoiFacts(tx, submissionId, { coauthorMonths: policy.coi_coauthor_months, now });
        const c = await conflictsFor(tx, facts, [actor.agentId]);
        conflictChecked.set(submissionId, (c.get(actor.agentId) ?? []).length > 0);
      }
      return conflictChecked.get(submissionId)!;
    };

    for (const { task, sub } of eligible) {
      if (await isConflicted(sub.id)) continue;
      const dueAt = addHours(now, task.kind === "review" ? policy.review_deadline_hours : policy.editorial_deadline_hours);
      const [claimed] = await tx
        .update(poolTasks)
        .set({ status: "claimed", claimedByAgentId: actor.agentId, claimedAt: now, dueAt, updatedAt: now })
        .where(and(eq(poolTasks.id, task.id), eq(poolTasks.status, "open")))
        .returning();
      if (!claimed) continue;
      let assignmentId: string | null = null;
      if (task.kind === "review") {
        const [a] = await tx
          .insert(reviewAssignments)
          .values({
            submissionId: sub.id,
            versionNo: task.versionNo,
            reviewerAgentId: actor.agentId,
            poolTaskId: task.id,
            status: "accepted",
            claimedAt: now,
            dueAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: reviewAssignments.id });
        assignmentId = a!.id;
      } else {
        await tx.update(submissions).set({ handlingEditorId: actor.agentId, updatedAt: now }).where(eq(submissions.id, sub.id));
      }
      await recordEvent(tx, actor, "pool.task_claimed", {
        journalId,
        submissionId: sub.id,
        payload: { pool_task_id: task.id, kind: task.kind, version_no: task.versionNo, due_at: dueAt.toISOString(), assignment_id: assignmentId },
        now,
      });
      return { task: claimed, assignmentId, alreadyHeld: false, standing };
    }

    if (open.length === 0) reasons.unshift("There are no open tasks of the kinds you may take in this journal right now.");
    else reasons.unshift("The open tasks right now are all ones you may not take (conflicts of interest, or your operator already works on those submissions).");
    return { task: null, reasons, standing };
  });
}

async function assignmentFor(tx: Db, task: PoolTaskRow): Promise<string | null> {
  if (task.kind !== "review") return null;
  const [a] = await tx
    .select({ id: reviewAssignments.id })
    .from(reviewAssignments)
    .where(eq(reviewAssignments.poolTaskId, task.id))
    .orderBy(sql`${reviewAssignments.claimedAt} DESC`)
    .limit(1);
  return a?.id ?? null;
}

async function currentKeywords(tx: Db, submissionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (submissionIds.length === 0) return out;
  const rows = await tx
    .select({ id: submissions.id, keywords: submissionVersions.keywords })
    .from(submissions)
    .innerJoin(
      submissionVersions,
      and(eq(submissionVersions.submissionId, submissions.id), eq(submissionVersions.versionNo, submissions.currentVersionNo)),
    )
    .where(inArray(submissions.id, submissionIds));
  for (const r of rows) out.set(r.id, r.keywords.map((k) => k.toLowerCase()));
  return out;
}

/** Give a claimed task back to the pool. A released review still counts toward the quota. */
export async function releaseTask(db: Db, actor: Actor & { type: "agent" }, poolTaskId: string, reason: string | null, now: Date) {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(poolTasks).where(eq(poolTasks.id, poolTaskId)).for("update");
    if (!task || task.claimedByAgentId !== actor.agentId) throw notFound("Task");
    if (task.status !== "claimed") throw invalidState(`This task is ${task.status}; only a task you hold can be released.`);
    await returnToPool(tx, task, "declined", now, reason);
    await recordEvent(tx, actor, "pool.task_released", {
      journalId: task.journalId,
      submissionId: task.submissionId,
      payload: { pool_task_id: task.id, kind: task.kind, reason },
      now,
    });
    return { status: "released" as const };
  });
}

/**
 * Put a claimed task back in the pool (released or expired). The review assignment, if any,
 * keeps the history with the given status.
 */
async function returnToPool(tx: Db, task: PoolTaskRow, assignmentStatus: "declined" | "expired", now: Date, reason: string | null = null) {
  await tx
    .update(poolTasks)
    .set({ status: "open", claimedByAgentId: null, claimedAt: null, dueAt: null, updatedAt: now })
    .where(eq(poolTasks.id, task.id));
  if (task.kind === "review") {
    await tx
      .update(reviewAssignments)
      .set({ status: assignmentStatus, releaseReason: reason, updatedAt: now })
      .where(and(eq(reviewAssignments.poolTaskId, task.id), eq(reviewAssignments.status, "accepted")));
  } else {
    await tx
      .update(submissions)
      .set({ handlingEditorId: null, updatedAt: now })
      .where(and(eq(submissions.id, task.submissionId), eq(submissions.handlingEditorId, task.claimedByAgentId!)));
  }
}

/** Claims past their due_at go back to the pool. Idempotent; each item in its own transaction. */
export async function expireClaims(db: Db, now: Date, batchSize = 100): Promise<number> {
  const overdue = await db
    .select({ id: poolTasks.id })
    .from(poolTasks)
    .where(and(eq(poolTasks.status, "claimed"), sql`${poolTasks.dueAt} < ${now}`))
    .orderBy(asc(poolTasks.dueAt))
    .limit(batchSize);
  let n = 0;
  for (const { id } of overdue) {
    const done = await db.transaction(async (tx) => {
      const [task] = await tx.select().from(poolTasks).where(eq(poolTasks.id, id)).for("update");
      if (!task || task.status !== "claimed" || !task.dueAt || task.dueAt >= now) return false;
      await returnToPool(tx, task, "expired", now);
      await recordEvent(tx, { type: "system" }, task.kind === "review" ? "review.expired" : "pool.editorial_expired", {
        journalId: task.journalId,
        submissionId: task.submissionId,
        payload: { pool_task_id: task.id, agent_id: task.claimedByAgentId },
        now,
      });
      return true;
    });
    if (done) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export type InboxTask = {
  task_id: string;
  kind: "write_review" | "editorial" | "revise_submission";
  role: "reviewer" | "editor" | "author";
  tool: string;
  arguments: Record<string, string>;
  agent_id: string;
  journal_slug: string;
  submission_id: string;
  submission_title: string;
  submission_status: string;
  due_at: Date | null;
  instructions: string;
};

function editorialInstructions(status: string, versionNo: number): string {
  if (status === "awaiting_decision") {
    return "The reviews are in. Read them with get_submission_for_editor, then call make_decision with a decision letter.";
  }
  return versionNo > 1
    ? "The authors submitted a revision. Read it with get_submission_for_editor, then send_to_review for another round or make_decision directly."
    : "Screen this new submission with get_submission_for_editor, then desk_reject it with a letter or send_to_review.";
}

/**
 * What the given agents must do now: the pool tasks they hold and the revisions they owe as
 * submitting authors. Earliest deadline first.
 */
export async function listInbox(db: Db, agentIds: string[], opts: { journalId?: string } = {}): Promise<InboxTask[]> {
  if (agentIds.length === 0) return [];
  const claimedConds = [inArray(poolTasks.claimedByAgentId, agentIds), eq(poolTasks.status, "claimed")];
  if (opts.journalId) claimedConds.push(eq(poolTasks.journalId, opts.journalId));
  const reviseConds = [inArray(submissions.submittingAgentId, agentIds), eq(submissions.status, "revision_requested")];
  if (opts.journalId) reviseConds.push(eq(submissions.journalId, opts.journalId));

  const [claimed, revise] = await Promise.all([
    db
      .select({ task: poolTasks, sub: submissions, slug: journals.slug, assignmentId: reviewAssignments.id })
      .from(poolTasks)
      .innerJoin(submissions, eq(submissions.id, poolTasks.submissionId))
      .innerJoin(journals, eq(journals.id, poolTasks.journalId))
      .leftJoin(reviewAssignments, and(eq(reviewAssignments.poolTaskId, poolTasks.id), eq(reviewAssignments.status, "accepted")))
      .where(and(...claimedConds)),
    db
      .select({ sub: submissions, slug: journals.slug })
      .from(submissions)
      .innerJoin(journals, eq(journals.id, submissions.journalId))
      .where(and(...reviseConds)),
  ]);

  const out: InboxTask[] = [
    ...claimed.map(({ task, sub, slug, assignmentId }): InboxTask => {
      const common = {
        task_id: task.id,
        agent_id: task.claimedByAgentId!,
        journal_slug: slug,
        submission_id: sub.id,
        submission_title: sub.title,
        submission_status: sub.status,
        due_at: task.dueAt,
      };
      return task.kind === "review"
        ? {
            ...common,
            kind: "write_review",
            role: "reviewer",
            tool: "get_manuscript_for_review",
            arguments: { assignment_id: assignmentId ?? "" },
            instructions: "Read the manuscript with get_manuscript_for_review, then call submit_review before the deadline.",
          }
        : {
            ...common,
            kind: "editorial",
            role: "editor",
            tool: "get_submission_for_editor",
            arguments: { submission_id: sub.id },
            instructions: editorialInstructions(sub.status, sub.currentVersionNo),
          };
    }),
    ...revise.map(
      ({ sub, slug }): InboxTask => ({
        task_id: sub.id,
        kind: "revise_submission",
        role: "author",
        tool: "submit_revision",
        arguments: { submission_id: sub.id },
        agent_id: sub.submittingAgentId,
        journal_slug: slug,
        submission_id: sub.id,
        submission_title: sub.title,
        submission_status: sub.status,
        due_at: sub.revisionDueAt,
        instructions: "The editor requested a revision. Read the decision and reviews with get_submission, then call submit_revision.",
      }),
    ),
  ];
  return out.sort((a, b) => (a.due_at?.getTime() ?? Infinity) - (b.due_at?.getTime() ?? Infinity) || a.task_id.localeCompare(b.task_id));
}

/** Open pool tasks per journal and kind (for dashboards and agent hints). */
export async function openPoolCounts(db: Db, journalId?: string) {
  const rows = await db
    .select({ journalId: poolTasks.journalId, kind: poolTasks.kind, status: poolTasks.status, n: sql<number>`count(*)`.mapWith(Number) })
    .from(poolTasks)
    .where(and(inArray(poolTasks.status, ["open", "claimed"]), ...(journalId ? [eq(poolTasks.journalId, journalId)] : [])))
    .groupBy(poolTasks.journalId, poolTasks.kind, poolTasks.status);
  return rows;
}
