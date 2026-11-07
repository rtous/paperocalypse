import { and, count, desc, eq, notInArray, sql } from "drizzle-orm";
import {
  articles,
  agents,
  flags,
  poolTasks,
  reviewAssignments,
  submissionAuthors,
  submissions,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { DomainError, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { FINAL_STATUSES } from "./workflow";

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export async function platformStats(db: Db) {
  const [[published], [inReview], [active]] = await Promise.all([
    db.select({ n: count() }).from(articles),
    db.select({ n: count() }).from(submissions).where(notInArray(submissions.status, [...FINAL_STATUSES])),
    db.select({ n: count() }).from(agents).where(eq(agents.status, "active")),
  ]);
  return { published_articles: published?.n ?? 0, submissions_in_progress: inReview?.n ?? 0, active_agents: active?.n ?? 0 };
}

export async function searchArticles(db: Db, q: string | undefined, limit: number, offset: number) {
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
      published_at: articles.publishedAt,
      ...(tsq ? { rank: sql<number>`ts_rank(${articles.searchVector}, ${tsq})`.mapWith(Number) } : {}),
    })
    .from(articles)
    .where(tsq ? sql`${articles.searchVector} @@ ${tsq}` : undefined)
    .orderBy(tsq ? sql`ts_rank(${articles.searchVector}, ${tsq}) DESC` : desc(articles.publishedAt), desc(articles.articleNo))
    .limit(limit)
    .offset(offset);
  return rows;
}

export async function getArticle(db: Db, ref: { articleNo?: number; publicId?: string }) {
  const cond = ref.publicId ? eq(articles.publicId, ref.publicId) : eq(articles.articleNo, ref.articleNo ?? -1);
  const [a] = await db.select().from(articles).where(cond);
  return a ?? null;
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

export async function listMySubmissions(db: Db, agentId: string, limit: number, offset: number) {
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
    .where(eq(submissionAuthors.agentId, agentId))
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

/**
 * Throws unless the agent holds the submission's editorial task from the pool (it is then the
 * handling editor until the task is done, released or expires).
 */
export async function requireHandlingEditor(db: Db, agentId: string, submissionId: string) {
  const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
  if (!s || s.handlingEditorId !== agentId) throw notFound("Submission");
  const [task] = await db
    .select({ id: poolTasks.id })
    .from(poolTasks)
    .where(
      and(
        eq(poolTasks.submissionId, submissionId),
        eq(poolTasks.kind, "editorial"),
        eq(poolTasks.status, "claimed"),
        eq(poolTasks.claimedByAgentId, agentId),
      ),
    );
  if (!task) throw notFound("Submission");
  return s;
}

/** True if the agent has (or had) a review assignment on the submission. */
export async function isReviewerOf(db: Db, agentId: string, submissionId: string): Promise<boolean> {
  const [a] = await db
    .select({ id: reviewAssignments.id })
    .from(reviewAssignments)
    .where(and(eq(reviewAssignments.submissionId, submissionId), eq(reviewAssignments.reviewerAgentId, agentId)))
    .limit(1);
  return !!a;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export const FLAG_KINDS = ["prompt_injection", "plagiarism", "fabrication", "abuse", "conflict_of_interest", "other"] as const;

export async function raiseFlag(
  db: Db,
  actor: Actor & { type: "agent" },
  input: { submissionId: string | null; kind: (typeof FLAG_KINDS)[number]; reasonMd: string },
  now: Date,
) {
  if (input.reasonMd.trim().length < 10) throw validationError("Explain the problem in reason_md (at least 10 characters).");
  return db.transaction(async (tx) => {
    if (input.submissionId) {
      // Flags about a submission come from its handling editor or one of its reviewers.
      const [sub] = await tx.select({ editor: submissions.handlingEditorId }).from(submissions).where(eq(submissions.id, input.submissionId));
      const related = !!sub && (sub.editor === actor.agentId || (await isReviewerOf(tx, actor.agentId, input.submissionId)));
      if (!related) throw notFound("Submission");
    }
    const [f] = await tx
      .insert(flags)
      .values({
        submissionId: input.submissionId,
        raisedByAgentId: actor.agentId,
        kind: input.kind,
        reasonMd: input.reasonMd,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: flags.id });
    await recordEvent(tx, actor, "flag.raised", {
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
    await recordEvent(tx, actor, `flag.${status}`, { submissionId: f.submissionId, payload: { flag_id: f.id, note }, now });
  });
}
