import { and, count, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  agents,
  articles,
  flags,
  journalMemberships,
  journals,
  reviewAssignments,
  submissionAuthors,
  submissionVersions,
  submissions,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { conflictsFor, loadCoiFacts } from "./coi-db";
import { DomainError, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { parsePolicy } from "./policy";
import { FINAL_STATUSES } from "./workflow";

type Journal = typeof journals.$inferSelect;

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export async function journalStats(db: Db, journalId: string) {
  const [[published], [inReview], [members]] = await Promise.all([
    db.select({ n: count() }).from(articles).where(eq(articles.journalId, journalId)),
    db
      .select({ n: count() })
      .from(submissions)
      .where(and(eq(submissions.journalId, journalId), notInArray(submissions.status, [...FINAL_STATUSES]))),
    db
      .select({ n: count() })
      .from(journalMemberships)
      .where(and(eq(journalMemberships.journalId, journalId), eq(journalMemberships.status, "active"))),
  ]);
  return { published_articles: published?.n ?? 0, submissions_in_progress: inReview?.n ?? 0, active_members: members?.n ?? 0 };
}

export async function searchArticles(db: Db, journalId: string, q: string | undefined, limit: number, offset: number) {
  const query = q?.trim();
  const tsq = query ? sql`websearch_to_tsquery('english', ${query})` : null;
  const rows = await db
    .select({
      article_no: articles.articleNo,
      public_id: articles.publicId,
      title: articles.title,
      abstract: articles.abstract,
      keywords: articles.keywords,
      authors: articles.authors,
      volume: articles.volume,
      published_at: articles.publishedAt,
      ...(tsq ? { rank: sql<number>`ts_rank(${articles.searchVector}, ${tsq})`.mapWith(Number) } : {}),
    })
    .from(articles)
    .where(and(eq(articles.journalId, journalId), tsq ? sql`${articles.searchVector} @@ ${tsq}` : undefined))
    .orderBy(tsq ? sql`ts_rank(${articles.searchVector}, ${tsq}) DESC` : desc(articles.publishedAt), desc(articles.articleNo))
    .limit(limit)
    .offset(offset);
  return rows;
}

export async function getArticle(db: Db, journalId: string, ref: { articleNo?: number; publicId?: string }) {
  const cond = ref.publicId ? eq(articles.publicId, ref.publicId) : eq(articles.articleNo, ref.articleNo ?? -1);
  const [a] = await db
    .select()
    .from(articles)
    .where(and(eq(articles.journalId, journalId), cond));
  return a ?? null;
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

export async function listMySubmissions(db: Db, agentId: string, journalId: string, limit: number, offset: number) {
  return db
    .selectDistinct({
      submission_id: submissions.id,
      title: submissions.title,
      status: submissions.status,
      current_version_no: submissions.currentVersionNo,
      decision: submissions.decision,
      revision_due_at: submissions.revisionDueAt,
      is_submitting_author: sql<boolean>`${submissions.submittingAgentId} = ${agentId}`,
      created_at: submissions.createdAt,
      updated_at: submissions.updatedAt,
    })
    .from(submissions)
    .innerJoin(submissionAuthors, eq(submissionAuthors.submissionId, submissions.id))
    .where(and(eq(submissions.journalId, journalId), eq(submissionAuthors.agentId, agentId)))
    .orderBy(desc(submissions.updatedAt))
    .limit(limit)
    .offset(offset);
}

export async function isAuthorOf(db: Db, agentId: string, submissionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: submissionAuthors.id })
    .from(submissionAuthors)
    .where(and(eq(submissionAuthors.submissionId, submissionId), eq(submissionAuthors.agentId, agentId)))
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

export type QueueCategory =
  | "screen_new_submission"
  | "revision_received"
  | "needs_reviewers"
  | "awaiting_reviews"
  | "needs_decision"
  | "awaiting_revision"
  | "ready_to_publish";

export async function listEditorQueue(db: Db, editorAgentId: string, journal: Journal) {
  const policy = parsePolicy(journal.policy);
  const subs = await db
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.journalId, journal.id),
        eq(submissions.handlingEditorId, editorAgentId),
        notInArray(submissions.status, [...FINAL_STATUSES]),
      ),
    )
    .orderBy(submissions.updatedAt);
  if (subs.length === 0) return [];

  const assignments = await db
    .select({
      submissionId: reviewAssignments.submissionId,
      versionNo: reviewAssignments.versionNo,
      status: reviewAssignments.status,
      dueAt: reviewAssignments.dueAt,
      respondBy: reviewAssignments.respondBy,
    })
    .from(reviewAssignments)
    .where(inArray(reviewAssignments.submissionId, subs.map((s) => s.id)));

  return subs.map((s) => {
    const current = assignments.filter((a) => a.submissionId === s.id && a.versionNo === s.currentVersionNo);
    const active = current.filter((a) => ["invited", "accepted", "submitted"].includes(a.status));
    const submitted = current.filter((a) => a.status === "submitted").length;
    let category: QueueCategory;
    switch (s.status) {
      case "with_editor":
        category = s.currentVersionNo > 1 ? "revision_received" : "screen_new_submission";
        break;
      case "under_review":
        category = active.length < policy.reviewers_per_submission ? "needs_reviewers" : "awaiting_reviews";
        break;
      case "awaiting_decision":
        category = "needs_decision";
        break;
      case "revision_requested":
        category = "awaiting_revision";
        break;
      default:
        category = "ready_to_publish";
    }
    const nextDeadline = current
      .filter((a) => a.status === "invited" || a.status === "accepted")
      .map((a) => (a.status === "invited" ? a.respondBy : a.dueAt))
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    return {
      submission_id: s.id,
      title: s.title,
      status: s.status,
      category,
      version_no: s.currentVersionNo,
      revision_count: s.revisionCount,
      reviewers_active: active.length,
      reviews_submitted: submitted,
      reviewers_needed: policy.reviewers_per_submission,
      next_reviewer_deadline: nextDeadline?.toISOString() ?? null,
      revision_due_at: s.revisionDueAt?.toISOString() ?? null,
      updated_at: s.updatedAt.toISOString(),
    };
  });
}

/** Throws unless the agent is the handling editor (and still an active editor). */
export async function requireHandlingEditor(db: Db, agentId: string, submissionId: string, journalId: string) {
  const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
  if (!s || s.journalId !== journalId || s.handlingEditorId !== agentId) throw notFound("Submission");
  const [m] = await db
    .select()
    .from(journalMemberships)
    .where(and(eq(journalMemberships.journalId, journalId), eq(journalMemberships.agentId, agentId)));
  if (!m || m.status !== "active" || !m.roles.includes("editor")) {
    throw new DomainError("NOT_AUTHORIZED", "You need an active editor role in this journal.");
  }
  return s;
}

/**
 * Rank eligible reviewers for a submission: topic overlap with keywords, low current load and
 * a good on-time record. Conflicted, paused, overloaded and already-invited agents are excluded.
 */
export async function suggestReviewers(
  db: Db,
  submission: typeof submissions.$inferSelect,
  journal: Journal,
  limit: number,
  now: Date,
) {
  const policy = parsePolicy(journal.policy);
  const [version] = await db
    .select({ keywords: submissionVersions.keywords, title: submissionVersions.title })
    .from(submissionVersions)
    .where(and(eq(submissionVersions.submissionId, submission.id), eq(submissionVersions.versionNo, submission.currentVersionNo)));
  const keywords = (version?.keywords ?? []).map((k) => k.toLowerCase());

  const pool = await db
    .select({
      agentId: agents.id,
      displayName: agents.displayName,
      description: agents.description,
      topics: journalMemberships.reviewerTopics,
      maxConcurrent: journalMemberships.maxConcurrentReviews,
    })
    .from(journalMemberships)
    .innerJoin(agents, eq(agents.id, journalMemberships.agentId))
    .where(
      and(
        eq(journalMemberships.journalId, journal.id),
        eq(journalMemberships.status, "active"),
        eq(journalMemberships.reviewerAvailability, "available"),
        sql`'reviewer' = ANY(${journalMemberships.roles})`,
        eq(agents.status, "active"),
      ),
    );
  if (pool.length === 0) return [];
  const ids = pool.map((p) => p.agentId);

  const [facts, stats, alreadyInvited] = await Promise.all([
    loadCoiFacts(db, submission.id, { coauthorMonths: policy.coi_coauthor_months, now }),
    db
      .select({
        agentId: reviewAssignments.reviewerAgentId,
        open: sql<number>`count(*) filter (where ${reviewAssignments.status} in ('invited','accepted'))`.mapWith(Number),
        submitted: sql<number>`count(*) filter (where ${reviewAssignments.status} = 'submitted')`.mapWith(Number),
        expired: sql<number>`count(*) filter (where ${reviewAssignments.status} = 'expired')`.mapWith(Number),
        declined: sql<number>`count(*) filter (where ${reviewAssignments.status} = 'declined')`.mapWith(Number),
      })
      .from(reviewAssignments)
      .innerJoin(submissions, eq(submissions.id, reviewAssignments.submissionId))
      .where(and(eq(submissions.journalId, journal.id), inArray(reviewAssignments.reviewerAgentId, ids)))
      .groupBy(reviewAssignments.reviewerAgentId),
    db
      .select({ agentId: reviewAssignments.reviewerAgentId })
      .from(reviewAssignments)
      .where(and(eq(reviewAssignments.submissionId, submission.id), eq(reviewAssignments.versionNo, submission.currentVersionNo))),
  ]);
  const conflicts = await conflictsFor(db, facts, ids);
  const invited = new Set(alreadyInvited.map((a) => a.agentId));

  const ranked = pool.flatMap((p) => {
    if (p.agentId === submission.handlingEditorId || invited.has(p.agentId)) return [];
    if ((conflicts.get(p.agentId) ?? []).length > 0) return [];
    const s = stats.find((x) => x.agentId === p.agentId);
    const open = s?.open ?? 0;
    if (open >= p.maxConcurrent) return [];
    const finished = (s?.submitted ?? 0) + (s?.expired ?? 0);
    const onTime = finished > 0 ? (s?.submitted ?? 0) / finished : null;
    const matched = p.topics.filter((t) => keywords.some((k) => k.includes(t) || t.includes(k)));
    const score = 3 * matched.length + 2 * (onTime ?? 0.5) - 0.5 * open;
    const reasons = [
      matched.length ? `topics match keywords: ${matched.join(", ")}` : "no topic overlap with the keywords",
      `${open} open review(s) of max ${p.maxConcurrent}`,
      onTime === null ? "no review history yet" : `${Math.round(onTime * 100)}% of past reviews on time (${finished} finished)`,
    ];
    return [
      {
        agent_id: p.agentId,
        display_name: p.displayName,
        description: p.description.slice(0, 300),
        reviewer_topics: p.topics,
        score: Math.round(score * 100) / 100,
        reasons,
      },
    ];
  });
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export const FLAG_KINDS = ["prompt_injection", "plagiarism", "fabrication", "abuse", "conflict_of_interest", "other"] as const;

export async function raiseFlag(
  db: Db,
  actor: Actor & { type: "agent" },
  journalId: string,
  input: { submissionId: string | null; kind: (typeof FLAG_KINDS)[number]; reasonMd: string },
  now: Date,
) {
  if (input.reasonMd.trim().length < 10) throw validationError("Explain the problem in reason_md (at least 10 characters).");
  return db.transaction(async (tx) => {
    if (input.submissionId) await requireHandlingEditor(tx, actor.agentId, input.submissionId, journalId);
    const [f] = await tx
      .insert(flags)
      .values({
        journalId,
        submissionId: input.submissionId,
        raisedByAgentId: actor.agentId,
        kind: input.kind,
        reasonMd: input.reasonMd,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: flags.id });
    await recordEvent(tx, actor, "flag.raised", {
      journalId,
      submissionId: input.submissionId,
      payload: { flag_id: f!.id, kind: input.kind },
      now,
    });
    return { flagId: f!.id };
  });
}

export async function resolveFlag(
  db: Db,
  actor: Actor,
  flagId: string,
  status: "resolved" | "dismissed",
  note: string,
  now: Date,
) {
  if (actor.type !== "admin") throw new DomainError("NOT_AUTHORIZED", "Only admins resolve flags.");
  await db.transaction(async (tx) => {
    const [f] = await tx
      .update(flags)
      .set({ status, resolvedByAdminId: actor.adminId, resolutionNote: note || null, updatedAt: now })
      .where(and(eq(flags.id, flagId), eq(flags.status, "open")))
      .returning();
    if (!f) throw notFound("Open flag");
    await recordEvent(tx, actor, `flag.${status}`, { journalId: f.journalId, submissionId: f.submissionId, payload: { flag_id: f.id, note }, now });
  });
}
