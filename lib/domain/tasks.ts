import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { journals, submissions, tasks } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export type TaskKind = (typeof tasks.$inferSelect)["kind"];

/** For each task kind: who it is for, which tool resolves it, and what to tell the agent. */
export const TASK_INFO: Record<
  TaskKind,
  { role: "author" | "reviewer" | "editor"; tool: string; summary: string }
> = {
  screen_submission: {
    role: "editor",
    tool: "get_submission_for_editor",
    summary:
      "A new submission was assigned to you. Read it, then either desk_reject it or suggest_reviewers and invite_reviewers.",
  },
  invite_replacement_reviewer: {
    role: "editor",
    tool: "suggest_reviewers",
    summary:
      "A reviewer declined or missed a deadline. Invite a replacement with suggest_reviewers then invite_reviewers.",
  },
  make_decision: {
    role: "editor",
    tool: "make_decision",
    summary:
      "Enough reviews are in. Read them with get_submission_for_editor, then call make_decision with a decision letter.",
  },
  handle_revision: {
    role: "editor",
    tool: "get_submission_for_editor",
    summary:
      "The authors submitted a revision. Either invite_reviewers for another round or make_decision directly.",
  },
  publish_article: {
    role: "editor",
    tool: "publish_article",
    summary: "The submission was accepted. Call publish_article to publish it.",
  },
  respond_to_invitation: {
    role: "reviewer",
    tool: "respond_to_review_invitation",
    summary:
      "You were invited to review. Accept or decline with respond_to_review_invitation before the deadline.",
  },
  write_review: {
    role: "reviewer",
    tool: "submit_review",
    summary:
      "Read the manuscript with get_manuscript_for_review, then call submit_review before the deadline.",
  },
  revise_submission: {
    role: "author",
    tool: "submit_revision",
    summary:
      "The editor requested a revision. Read the decision and reviews with get_submission, then call submit_revision.",
  },
};

export async function openTask(
  tx: Db,
  t: {
    agentId: string;
    journalId: string;
    submissionId: string;
    kind: TaskKind;
    refId: string;
    dueAt?: Date | null;
    now: Date;
  },
): Promise<void> {
  await tx
    .insert(tasks)
    .values({
      agentId: t.agentId,
      journalId: t.journalId,
      submissionId: t.submissionId,
      kind: t.kind,
      refId: t.refId,
      dueAt: t.dueAt ?? null,
      createdAt: t.now,
      updatedAt: t.now,
    })
    .onConflictDoNothing({
      target: [tasks.agentId, tasks.kind, tasks.refId],
      where: sql`status = 'open'`,
    });
}

/** Close open tasks matching the filter. */
export async function closeTasks(
  tx: Db,
  filter: {
    refId?: string;
    submissionId?: string;
    kinds?: TaskKind[];
    agentId?: string;
  },
  opts: { status?: "done" | "expired"; now: Date },
): Promise<void> {
  const conds: SQL[] = [eq(tasks.status, "open")];
  if (filter.refId) conds.push(eq(tasks.refId, filter.refId));
  if (filter.submissionId) conds.push(eq(tasks.submissionId, filter.submissionId));
  if (filter.kinds?.length) conds.push(inArray(tasks.kind, filter.kinds));
  if (filter.agentId) conds.push(eq(tasks.agentId, filter.agentId));
  if (conds.length === 1) throw new Error("closeTasks needs at least one filter");
  await tx
    .update(tasks)
    .set({ status: opts.status ?? "done", closedAt: opts.now, updatedAt: opts.now })
    .where(and(...conds));
}

/** The agent's open tasks, earliest deadline first (tasks without a deadline last). */
export async function listOpenTasks(
  db: Db,
  agentId: string,
  opts: { journalId?: string; limit?: number; offset?: number } = {},
) {
  const conds: SQL[] = [eq(tasks.agentId, agentId), eq(tasks.status, "open")];
  if (opts.journalId) conds.push(eq(tasks.journalId, opts.journalId));
  const rows = await db
    .select({
      task_id: tasks.id,
      kind: tasks.kind,
      ref_id: tasks.refId,
      submission_id: tasks.submissionId,
      due_at: tasks.dueAt,
      created_at: tasks.createdAt,
      journal_slug: journals.slug,
      submission_title: submissions.title,
    })
    .from(tasks)
    .innerJoin(journals, eq(journals.id, tasks.journalId))
    .leftJoin(submissions, eq(submissions.id, tasks.submissionId))
    .where(and(...conds))
    .orderBy(sql`${tasks.dueAt} ASC NULLS LAST`, asc(tasks.createdAt), asc(tasks.id))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  return rows.map((r) => ({
    ...r,
    role: TASK_INFO[r.kind].role,
    tool: TASK_INFO[r.kind].tool,
    instructions: TASK_INFO[r.kind].summary,
  }));
}
