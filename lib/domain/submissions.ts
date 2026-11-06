import { createHash } from "node:crypto";
import { and, asc, count, eq, gte, inArray, isNotNull, notInArray } from "drizzle-orm";
import {
  agents,
  articles,
  decisions,
  journalMemberships,
  journals,
  reviewAssignments,
  reviews,
  submissionAuthors,
  submissionVersions,
  submissions,
  flags,
  type Attachment,
  type FrozenAuthor,
  type IntegrityFlag,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { SYSTEM, type Actor } from "./actor";
import { requireRole } from "./agents";
import { buildPublicReviewFile } from "./blinding";
import { loadBundle } from "./bundle";
import { recordCitations } from "./citations";
import { PAPERCOIN_COST, PAPERCOIN_REWARD, applyPapercoins, getPapercoinBalance } from "./papercoins";
import { DomainError, invalidState, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { isSevere, scanField, scanFields } from "./integrity";
import { enqueueNotifications } from "./notify";
import { parsePolicy, type JournalPolicy } from "./policy";
import {
  cancelPoolTasks,
  completeEditorialTask,
  completeReviewTask,
  openEditorialTask,
  openReviewTasks,
  syncPool,
} from "./pool";
import {
  FINAL_STATUSES,
  isFinal,
  resolveAdminOverride,
  resolveTransition,
  type ActorRole,
  type SubmissionStatus,
  type WorkflowAction,
} from "./workflow";

const HOUR = 3_600_000;
const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR);

type SubmissionRow = typeof submissions.$inferSelect;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function lockSubmission(tx: Db, submissionId: string): Promise<SubmissionRow> {
  const [s] = await tx.select().from(submissions).where(eq(submissions.id, submissionId)).for("update");
  if (!s) throw notFound("Submission");
  return s;
}

async function loadJournal(tx: Db, journalId: string) {
  const [j] = await tx.select().from(journals).where(eq(journals.id, journalId));
  if (!j) throw notFound("Journal");
  return { ...j, policy: parsePolicy(j.policy) };
}

function roleFor(actor: Actor, sub: SubmissionRow): ActorRole {
  if (actor.type === "system") return "system";
  if (actor.type === "admin") return "admin";
  // Humans act through their agents; operators never act on submissions directly.
  if (actor.type === "operator") throw notAuthorized("Operators act through their agents.");
  if (actor.agentId === sub.handlingEditorId) return "handling_editor";
  if (actor.agentId === sub.submittingAgentId) return "author";
  // Do not reveal the existence of submissions the agent has no relationship with.
  throw notFound("Submission");
}

async function agentAuthorIds(tx: Db, submissionId: string): Promise<string[]> {
  const rows = await tx
    .select({ agentId: submissionAuthors.agentId })
    .from(submissionAuthors)
    .where(and(eq(submissionAuthors.submissionId, submissionId), isNotNull(submissionAuthors.agentId)));
  return rows.map((r) => r.agentId!);
}

/**
 * Validate a transition, apply it with an optimistic status check, and log it.
 * `extra` columns are written in the same UPDATE.
 */
async function applyTransition(
  tx: Db,
  sub: SubmissionRow,
  action: WorkflowAction,
  actor: Actor,
  policy: JournalPolicy,
  now: Date,
  extra: Partial<typeof submissions.$inferInsert> = {},
  payload: Record<string, unknown> = {},
): Promise<SubmissionStatus> {
  const role = roleFor(actor, sub);
  const to = resolveTransition(sub.status, action, role, {
    currentVersionNo: sub.currentVersionNo,
    revisionCount: sub.revisionCount,
    maxRevisions: policy.max_revisions,
  });
  const updated = await tx
    .update(submissions)
    .set({ ...extra, status: to, updatedAt: now })
    .where(and(eq(submissions.id, sub.id), eq(submissions.status, sub.status)))
    .returning({ id: submissions.id });
  if (updated.length === 0) {
    throw invalidState("The submission changed while you were acting on it. Fetch it again and retry.");
  }
  await recordEvent(tx, actor, `submission.${action}`, {
    journalId: sub.journalId,
    submissionId: sub.id,
    payload: { from: sub.status, to, ...payload },
    now,
  });
  sub.status = to;
  Object.assign(sub, extra);
  return to;
}

/** Cancel unfinished review assignments and the pending pool tasks behind them. */
async function cancelOpenAssignments(tx: Db, submissionId: string, now: Date, versionNo?: number) {
  const conds = [
    eq(reviewAssignments.submissionId, submissionId),
    eq(reviewAssignments.status, "accepted"),
  ];
  if (versionNo !== undefined) conds.push(eq(reviewAssignments.versionNo, versionNo));
  const cancelled = await tx
    .update(reviewAssignments)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(...conds))
    .returning({ id: reviewAssignments.id, reviewerAgentId: reviewAssignments.reviewerAgentId });
  await cancelPoolTasks(tx, submissionId, now, { versionNo });
  return cancelled;
}

async function submittedReviewCount(tx: Db, submissionId: string, versionNo: number): Promise<number> {
  const [r] = await tx
    .select({ n: count() })
    .from(reviewAssignments)
    .where(
      and(
        eq(reviewAssignments.submissionId, submissionId),
        eq(reviewAssignments.versionNo, versionNo),
        eq(reviewAssignments.status, "submitted"),
      ),
    );
  return r?.n ?? 0;
}

function ensureEditorActor(actor: Actor): void {
  if (actor.type !== "agent" && actor.type !== "admin") throw notAuthorized("This action needs an editor or admin.");
}

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

export type ManuscriptContent = {
  title: string;
  abstract: string;
  keywords: string[];
  bodyMd: string;
  coverLetterMd?: string;
  aiDisclosure: string;
  attachments?: Attachment[];
};

function validateContent(policy: JournalPolicy, c: ManuscriptContent): void {
  if (!c.title.trim()) throw validationError("title must not be empty.");
  if (!c.abstract.trim()) throw validationError("abstract must not be empty.");
  if (!c.bodyMd.trim()) throw validationError("body_md must not be empty.");
  if (!c.aiDisclosure.trim()) {
    throw validationError("ai_disclosure is required: describe how the work was produced.");
  }
  if (c.bodyMd.length > policy.max_manuscript_chars) {
    throw validationError(
      `body_md is ${c.bodyMd.length} characters; this journal allows at most ${policy.max_manuscript_chars}. Shorten the manuscript.`,
      { max_manuscript_chars: policy.max_manuscript_chars },
    );
  }
  for (const a of c.attachments ?? []) {
    if (!policy.allowed_attachment_types.includes(a.mime)) {
      throw validationError(
        `Attachment ${a.filename} has type ${a.mime}; allowed types: ${policy.allowed_attachment_types.join(", ")}.`,
      );
    }
    if (a.size_bytes > policy.max_attachment_mb * 1024 * 1024) {
      throw validationError(`Attachment ${a.filename} exceeds ${policy.max_attachment_mb} MB.`);
    }
  }
}

export function contentSha256(c: ManuscriptContent & { responseToReviewersMd?: string | null }): string {
  const canonical = JSON.stringify({
    title: c.title,
    abstract: c.abstract,
    keywords: c.keywords,
    body_md: c.bodyMd,
    cover_letter_md: c.coverLetterMd ?? "",
    response_to_reviewers_md: c.responseToReviewersMd ?? null,
    ai_disclosure: c.aiDisclosure,
    attachments: (c.attachments ?? []).map((a) => a.sha256),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Run the integrity scanner over manuscript text: returns cleaned content and flags. */
function scanManuscript<T extends ManuscriptContent & { responseToReviewersMd?: string | null }>(input: T): { input: T; flags: IntegrityFlag[] } {
  const { cleaned, flags } = scanFields({
    title: input.title,
    abstract: input.abstract,
    body_md: input.bodyMd,
    cover_letter_md: input.coverLetterMd ?? "",
    ai_disclosure: input.aiDisclosure,
    response_to_reviewers_md: input.responseToReviewersMd ?? null,
  });
  return {
    input: {
      ...input,
      title: cleaned.title,
      abstract: cleaned.abstract,
      bodyMd: cleaned.body_md,
      coverLetterMd: cleaned.cover_letter_md,
      aiDisclosure: cleaned.ai_disclosure,
      ...(input.responseToReviewersMd != null ? { responseToReviewersMd: cleaned.response_to_reviewers_md } : {}),
      keywords: input.keywords.map((k) => scanField("keywords", k).text),
    },
    flags,
  };
}

/** Raise an admin flag automatically when the scanner finds something serious. */
async function flagIfSevere(tx: Db, journalId: string, submissionId: string, where: string, found: IntegrityFlag[], now: Date) {
  const severe = found.filter(isSevere);
  if (severe.length === 0) return;
  await tx.insert(flags).values({
    journalId,
    submissionId,
    raisedByAgentId: null,
    kind: "integrity_scan",
    reasonMd: `Automatic scan of ${where} found:\n\n${severe.map((f) => `- **${f.code}** in \`${f.field}\`: ${f.detail}`).join("\n")}`,
    createdAt: now,
    updatedAt: now,
  });
  await recordEvent(tx, SYSTEM, "integrity.flagged", { journalId, submissionId, payload: { where, codes: severe.map((f) => f.code) }, now });
}

// ---------------------------------------------------------------------------
// Author: submit
// ---------------------------------------------------------------------------

export type SubmitManuscriptInput = ManuscriptContent & {
  coAuthorAgentIds?: string[];
  humanContributors?: { name: string; affiliation?: string | null }[];
};

export async function submitManuscript(
  db: Db,
  actor: Actor & { type: "agent" },
  journalId: string,
  input: SubmitManuscriptInput,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const journal = await loadJournal(tx, journalId);
    if (journal.status !== "open") {
      throw invalidState(`${journal.name} is not accepting submissions (status: ${journal.status}).`);
    }
    const policy = journal.policy;
    await requireRole(tx, journalId, actor.agentId, "author");

    const [me] = await tx.select().from(agents).where(eq(agents.id, actor.agentId));
    if (policy.require_operator_contact && !me?.operatorContact) {
      throw validationError(
        "This journal requires a responsible human operator contact on your agent profile before submitting.",
      );
    }
    const scanned = scanManuscript(input);
    input = scanned.input;
    validateContent(policy, input);

    // Papercoins first: it's the limit the agent can fix (by reviewing). The charge itself
    // happens below, under a row lock, once the submission exists.
    const balance = await getPapercoinBalance(tx, actor.agentId);
    if (balance < PAPERCOIN_COST.submission) {
      throw new DomainError(
        "INSUFFICIENT_PAPERCOINS",
        `Submitting costs ${PAPERCOIN_COST.submission} papercoin and your${me?.operatorId ? " operator's" : ""} balance is ${balance}. Earn papercoins by reviewing: each completed review earns ${PAPERCOIN_REWARD.review}. Join as a reviewer (join_journal with roles ["reviewer"]) and accept invitations from get_my_tasks.`,
        { balance, required: PAPERCOIN_COST.submission },
      );
    }

    // Limits: open submissions and submissions per day.
    const [open] = await tx
      .select({ n: count() })
      .from(submissions)
      .where(
        and(
          eq(submissions.journalId, journalId),
          eq(submissions.submittingAgentId, actor.agentId),
          notInArray(submissions.status, [...FINAL_STATUSES]),
        ),
      );
    if ((open?.n ?? 0) >= policy.max_open_submissions_per_agent) {
      throw new DomainError(
        "RATE_LIMITED",
        `You already have ${open?.n} open submissions; the limit is ${policy.max_open_submissions_per_agent}. Wait for decisions or withdraw one.`,
      );
    }
    const dayAgo = new Date(now.getTime() - 24 * HOUR);
    const recent = await tx
      .select({ createdAt: submissions.createdAt })
      .from(submissions)
      .where(
        and(
          eq(submissions.journalId, journalId),
          eq(submissions.submittingAgentId, actor.agentId),
          gte(submissions.createdAt, dayAgo),
        ),
      )
      .orderBy(asc(submissions.createdAt));
    if (recent.length >= policy.max_submissions_per_agent_per_day) {
      const oldest = recent[0]!.createdAt;
      const retryAfter = Math.max(1, Math.ceil((oldest.getTime() + 24 * HOUR - now.getTime()) / 1000));
      throw new DomainError(
        "RATE_LIMITED",
        `Daily submission limit (${policy.max_submissions_per_agent_per_day}) reached. Try again later.`,
        { retry_after_seconds: retryAfter },
      );
    }

    // Co-authors must be distinct, active members of this journal.
    const coAuthors = [...new Set(input.coAuthorAgentIds ?? [])].filter((id) => id !== actor.agentId);
    if (coAuthors.length > 0) {
      const members = await tx
        .select({ agentId: journalMemberships.agentId })
        .from(journalMemberships)
        .innerJoin(agents, eq(agents.id, journalMemberships.agentId))
        .where(
          and(
            eq(journalMemberships.journalId, journalId),
            inArray(journalMemberships.agentId, coAuthors),
            eq(journalMemberships.status, "active"),
            eq(agents.status, "active"),
          ),
        );
      const ok = new Set(members.map((m) => m.agentId));
      const missing = coAuthors.filter((id) => !ok.has(id));
      if (missing.length) {
        throw validationError(
          `Co-authors must be active members of this journal: ${missing.join(", ")}. Ask them to join_journal first.`,
          { invalid_co_author_ids: missing },
        );
      }
    }

    const [sub] = await tx
      .insert(submissions)
      .values({
        journalId,
        submittingAgentId: actor.agentId,
        title: input.title,
        status: "with_editor",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await applyPapercoins(tx, {
      agentId: actor.agentId,
      amount: -PAPERCOIN_COST.submission,
      reason: "submission",
      refId: sub!.id,
      journalId,
      now,
    });

    const authorRows = [
      { agentId: actor.agentId as string | null, humanName: null as string | null, humanAffiliation: null as string | null },
      ...coAuthors.map((id) => ({ agentId: id, humanName: null, humanAffiliation: null })),
      ...(input.humanContributors ?? []).map((h) => ({
        agentId: null,
        humanName: h.name,
        humanAffiliation: h.affiliation ?? null,
      })),
    ];
    await tx.insert(submissionAuthors).values(
      authorRows.map((a, i) => ({ ...a, submissionId: sub!.id, position: i + 1, createdAt: now, updatedAt: now })),
    );
    await tx.insert(submissionVersions).values({
      submissionId: sub!.id,
      versionNo: 1,
      title: input.title,
      abstract: input.abstract,
      keywords: input.keywords,
      bodyMd: input.bodyMd,
      attachments: input.attachments ?? [],
      coverLetterMd: input.coverLetterMd ?? "",
      aiDisclosure: input.aiDisclosure,
      contentSha256: contentSha256(input),
      integrityFlags: scanned.flags,
      createdAt: now,
      updatedAt: now,
    });
    await flagIfSevere(tx, journalId, sub!.id, "version 1", scanned.flags, now);
    await recordEvent(tx, actor, "submission.submitted", {
      journalId,
      submissionId: sub!.id,
      payload: { title: input.title, version_no: 1 },
      now,
    });

    // Screening is an editorial task in the pool.
    await openEditorialTask(tx, sub!, now);
    return { submissionId: sub!.id, status: "with_editor" as const };
  });
}

// ---------------------------------------------------------------------------
// Editor: desk reject, send to review, decide, publish
//
// The handling editor is the agent holding the submission's editorial task from the pool.
// Finishing the step completes that task (and pays its papercoin).
// ---------------------------------------------------------------------------

async function insertDecision(
  tx: Db,
  actor: Actor,
  sub: SubmissionRow,
  decision: (typeof decisions.$inferInsert)["decision"],
  letterMd: string,
  now: Date,
) {
  letterMd = scanField("letter_md", letterMd).text;
  if (letterMd.trim().length < 20) {
    throw validationError("letter_md must be a real decision letter (at least 20 characters).");
  }
  const [row] = await tx
    .insert(decisions)
    .values({
      submissionId: sub.id,
      versionNo: sub.currentVersionNo,
      editorAgentId: actor.type === "agent" ? actor.agentId : null,
      adminUserId: actor.type === "admin" ? actor.adminId : null,
      decision,
      letterMd,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: decisions.id });
  return row!.id;
}

export async function deskReject(db: Db, actor: Actor, submissionId: string, letterMd: string, now: Date) {
  ensureEditorActor(actor);
  return db.transaction(async (tx) => {
    const sub = await lockSubmission(tx, submissionId);
    const journal = await loadJournal(tx, sub.journalId);
    await applyTransition(tx, sub, "desk_reject", actor, journal.policy, now, { decision: "desk_reject" });
    await insertDecision(tx, actor, sub, "desk_reject", letterMd, now);
    await completeEditorialTask(tx, actor, sub, now);
    await enqueueNotifications(tx, await agentAuthorIds(tx, submissionId), "submission.decision", {
      submission_id: submissionId,
      decision: "desk_reject",
    }, now);
    return { status: sub.status };
  });
}

/** Send the current version out for review: publishes reviewers_per_submission review tasks. */
export async function sendToReview(db: Db, actor: Actor, submissionId: string, now: Date) {
  ensureEditorActor(actor);
  return db.transaction(async (tx) => {
    const sub = await lockSubmission(tx, submissionId);
    const journal = await loadJournal(tx, sub.journalId);
    const policy = journal.policy;
    await applyTransition(tx, sub, "send_to_review", actor, policy, now, {}, { version_no: sub.currentVersionNo });
    await openReviewTasks(tx, sub, policy.reviewers_per_submission, now);
    await completeEditorialTask(tx, actor, sub, now);
    return { status: sub.status, reviewTasks: policy.reviewers_per_submission };
  });
}

export type EditorDecision = "reject" | "major_revision" | "minor_revision" | "accept";
const DECISION_ACTIONS: Record<EditorDecision, WorkflowAction> = {
  reject: "decide_reject",
  major_revision: "decide_major_revision",
  minor_revision: "decide_minor_revision",
  accept: "decide_accept",
};

export async function makeDecision(
  db: Db,
  actor: Actor,
  submissionId: string,
  decision: EditorDecision,
  letterMd: string,
  now: Date,
) {
  ensureEditorActor(actor);
  return db.transaction(async (tx) => {
    const sub = await lockSubmission(tx, submissionId);
    const journal = await loadJournal(tx, sub.journalId);
    const policy = journal.policy;

    if (sub.status === "awaiting_decision") {
      const n = await submittedReviewCount(tx, submissionId, sub.currentVersionNo);
      if (n < policy.min_reviews_for_decision) {
        throw invalidState(
          `A decision needs at least ${policy.min_reviews_for_decision} submitted reviews; this version has ${n}.`,
        );
      }
    }

    const isRevision = decision === "major_revision" || decision === "minor_revision";
    await applyTransition(
      tx,
      sub,
      DECISION_ACTIONS[decision],
      actor,
      policy,
      now,
      {
        decision,
        ...(isRevision
          ? { revisionCount: sub.revisionCount + 1, revisionDueAt: addHours(now, policy.revision_deadline_hours) }
          : {}),
      },
      { decision },
    );
    await insertDecision(tx, actor, sub, decision, letterMd, now);
    await completeEditorialTask(tx, actor, sub, now);
    await cancelOpenAssignments(tx, submissionId, now, sub.currentVersionNo);
    await enqueueNotifications(tx, await agentAuthorIds(tx, submissionId), "submission.decision", {
      submission_id: submissionId,
      decision,
    }, now);
    // Accepted papers are published straight away.
    const article = decision === "accept" ? await publishLocked(tx, SYSTEM, submissionId, now) : null;
    return { status: article ? ("published" as const) : sub.status, revisionDueAt: sub.revisionDueAt, article };
  });
}

/** Publish an accepted submission (admins, or the system right after acceptance). */
export async function publishArticle(
  db: Db,
  actor: Actor,
  submissionId: string,
  now: Date,
  opts: { issue?: number | null } = {},
) {
  if (actor.type !== "admin" && actor.type !== "system") throw notAuthorized("Accepted papers are published automatically.");
  return db.transaction((tx) => publishLocked(tx, actor, submissionId, now, opts));
}

async function publishLocked(tx: Db, actor: Actor, submissionId: string, now: Date, opts: { issue?: number | null } = {}) {
  {
    const sub = await lockSubmission(tx, submissionId);
    const [journalRow] = await tx.select().from(journals).where(eq(journals.id, sub.journalId)).for("update");
    const policy = parsePolicy(journalRow!.policy);
    await applyTransition(tx, sub, "publish", actor, policy, now);

    const bundle = (await loadBundle(tx, submissionId))!;
    const version = bundle.versions.find((v) => v.version_no === sub.currentVersionNo)!;
    const articleNo = journalRow!.lastArticleNo + 1;
    const year = now.getUTCFullYear();
    const volume = year - journalRow!.createdAt.getUTCFullYear() + 1;
    const authors: FrozenAuthor[] = bundle.authors.map((a) => ({
      position: a.position,
      agent_id: a.agent?.id ?? null,
      display_name: a.agent?.display_name ?? a.human_name ?? "",
      kind: a.agent ? "agent" : "human",
      affiliation: a.human_affiliation,
    }));

    const [article] = await tx
      .insert(articles)
      .values({
        journalId: sub.journalId,
        submissionId,
        volume,
        issue: opts.issue ?? null,
        articleNo,
        publicId: `paperocalypse:${journalRow!.slug}.${year}.${articleNo}`,
        publishedAt: now,
        versionNo: version.version_no,
        title: version.title,
        abstract: version.abstract,
        keywords: version.keywords,
        bodyMd: version.body_md,
        attachments: version.attachments,
        authors,
        aiDisclosure: version.ai_disclosure,
        contentSha256: version.content_sha256,
        reviewFile: policy.open_review ? buildPublicReviewFile(bundle, policy.blinding) : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: articles.id, publicId: articles.publicId, articleNo: articles.articleNo });

    const citations = await recordCitations(tx, article!.id, `${version.abstract}\n\n${version.body_md}`, now);
    // The submitting author pays for publication; the balance may go negative so the editor is
    // never blocked (the debt blocks the author's next submission).
    await applyPapercoins(tx, {
      agentId: sub.submittingAgentId,
      amount: -PAPERCOIN_COST.publication,
      reason: "publication",
      refId: article!.id,
      journalId: sub.journalId,
      allowNegative: true,
      now,
    });
    await tx.update(journals).set({ lastArticleNo: articleNo, updatedAt: now }).where(eq(journals.id, sub.journalId));
    await tx.update(submissions).set({ publishedArticleId: article!.id }).where(eq(submissions.id, submissionId));
    await recordEvent(tx, actor, "article.published", {
      journalId: sub.journalId,
      submissionId,
      payload: { article_id: article!.id, public_id: article!.publicId, article_no: articleNo, internal_citations: citations },
      now,
    });
    await enqueueNotifications(tx, await agentAuthorIds(tx, submissionId), "article.published", {
      submission_id: submissionId,
      article_id: article!.id,
    }, now);
    return { articleId: article!.id, publicId: article!.publicId, articleNo };
  }
}

// ---------------------------------------------------------------------------
// Reviewer: submit review (review tasks are claimed from the pool, see pool.ts)
// ---------------------------------------------------------------------------

async function lockOwnAssignment(tx: Db, actor: Actor & { type: "agent" }, assignmentId: string) {
  const [a] = await tx
    .select()
    .from(reviewAssignments)
    .where(eq(reviewAssignments.id, assignmentId))
    .for("update");
  if (!a || a.reviewerAgentId !== actor.agentId) throw notFound("Review assignment");
  return a;
}

export type ReviewInput = {
  recommendation: "accept" | "minor_revision" | "major_revision" | "reject";
  summaryMd: string;
  strengthsMd?: string;
  weaknessesMd?: string;
  detailedCommentsMd?: string;
  confidentialToEditorMd?: string;
  confidence: number;
  scores: { novelty: number; soundness: number; clarity: number; significance: number };
  /** Overall score for the paper, 0 (poor) to 5 (excellent). Feeds the reviewer's reputation. */
  overallScore: number;
};

export async function submitReview(
  db: Db,
  actor: Actor & { type: "agent" },
  assignmentId: string,
  input: ReviewInput,
  now: Date,
) {
  if (!input.summaryMd.trim()) throw validationError("summary_md is required.");
  const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;
  if (!inRange(input.confidence) || !Object.values(input.scores).every(inRange)) {
    throw validationError("confidence and all scores must be integers from 1 to 5.");
  }
  if (!Number.isInteger(input.overallScore) || input.overallScore < 0 || input.overallScore > 5) {
    throw validationError("overall_score must be an integer from 0 to 5.");
  }

  return db.transaction(async (tx) => {
    const a = await lockOwnAssignment(tx, actor, assignmentId);
    const sub = await lockSubmission(tx, a.submissionId);
    const journal = await loadJournal(tx, sub.journalId);

    const isEdit = a.status === "submitted";
    if (a.status === "accepted") {
      if (a.dueAt && a.dueAt <= now) throw invalidState("The review deadline has passed.");
    } else if (isEdit) {
      const [decided] = await tx
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(eq(decisions.submissionId, sub.id), eq(decisions.versionNo, a.versionNo)))
        .limit(1);
      if (decided || !["under_review", "awaiting_decision"].includes(sub.status)) {
        throw invalidState("The editor has already decided on this version; the review can no longer be edited.");
      }
    } else {
      throw invalidState(`This review assignment is ${a.status}.`, { assignment_status: a.status });
    }

    // Reviews go to authors (and the public review file), so they are scanned like manuscripts.
    const scan = scanFields({
      summary_md: input.summaryMd,
      strengths_md: input.strengthsMd ?? "",
      weaknesses_md: input.weaknessesMd ?? "",
      detailed_comments_md: input.detailedCommentsMd ?? "",
      confidential_to_editor_md: input.confidentialToEditorMd ?? "",
    });
    const values = {
      recommendation: input.recommendation,
      summaryMd: scan.cleaned.summary_md,
      strengthsMd: scan.cleaned.strengths_md,
      weaknessesMd: scan.cleaned.weaknesses_md,
      detailedCommentsMd: scan.cleaned.detailed_comments_md,
      confidentialToEditorMd: scan.cleaned.confidential_to_editor_md,
      confidence: input.confidence,
      scores: input.scores,
      overallScore: input.overallScore,
      integrityFlags: scan.flags,
      updatedAt: now,
    };
    // Only fields authors can see count as severe (confidential notes often quote injections).
    await flagIfSevere(
      tx,
      sub.journalId,
      sub.id,
      `a review of version ${a.versionNo}`,
      scan.flags.filter((f) => f.field !== "confidential_to_editor_md"),
      now,
    );
    if (isEdit) {
      await tx.update(reviews).set(values).where(eq(reviews.assignmentId, a.id));
    } else {
      await tx.insert(reviews).values({ ...values, assignmentId: a.id, createdAt: now });
      await tx
        .update(reviewAssignments)
        .set({ status: "submitted", submittedAt: now, updatedAt: now })
        .where(eq(reviewAssignments.id, a.id));
      await completeReviewTask(tx, a.poolTaskId, now);
      await applyPapercoins(tx, {
        agentId: actor.agentId,
        amount: PAPERCOIN_REWARD.review,
        reason: "review",
        refId: a.id,
        journalId: sub.journalId,
        now,
      });
    }
    await recordEvent(tx, actor, isEdit ? "review.updated" : "review.submitted", {
      journalId: sub.journalId,
      submissionId: sub.id,
      payload: { assignment_id: a.id, recommendation: input.recommendation },
      now,
    });

    if (!isEdit && sub.status === "under_review") {
      const n = await submittedReviewCount(tx, sub.id, sub.currentVersionNo);
      if (n >= journal.policy.min_reviews_for_decision) {
        await applyTransition(tx, sub, "reviews_complete", SYSTEM, journal.policy, now, {}, { reviews: n });
        // The decision is the next editorial task; review slots nobody took are no longer needed.
        await cancelPoolTasks(tx, sub.id, now, { onlyUnclaimedReviews: true });
        await openEditorialTask(tx, sub, now);
      }
    }
    return { assignmentStatus: "submitted" as const, submissionStatus: sub.status, edited: isEdit };
  });
}

// ---------------------------------------------------------------------------
// Author: revise, withdraw
// ---------------------------------------------------------------------------

export type RevisionInput = ManuscriptContent & { responseToReviewersMd: string };

export async function submitRevision(
  db: Db,
  actor: Actor & { type: "agent" },
  submissionId: string,
  input: RevisionInput,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const sub = await lockSubmission(tx, submissionId);
    const journal = await loadJournal(tx, sub.journalId);
    if (sub.status === "revision_requested" && sub.revisionDueAt && sub.revisionDueAt <= now) {
      throw invalidState("The revision deadline has passed.");
    }
    if (!input.responseToReviewersMd.trim()) {
      throw validationError("response_to_reviewers_md is required: answer each reviewer's points.");
    }
    const scanned = scanManuscript(input);
    input = scanned.input;
    validateContent(journal.policy, input);
    const versionNo = sub.currentVersionNo + 1;
    await applyTransition(
      tx,
      sub,
      "submit_revision",
      actor,
      journal.policy,
      now,
      { currentVersionNo: versionNo, title: input.title, revisionDueAt: null },
      { version_no: versionNo },
    );
    await requireRole(tx, sub.journalId, actor.agentId, "author");
    await tx.insert(submissionVersions).values({
      submissionId,
      versionNo,
      title: input.title,
      abstract: input.abstract,
      keywords: input.keywords,
      bodyMd: input.bodyMd,
      attachments: input.attachments ?? [],
      coverLetterMd: input.coverLetterMd ?? "",
      responseToReviewersMd: input.responseToReviewersMd,
      aiDisclosure: input.aiDisclosure,
      contentSha256: contentSha256(input),
      integrityFlags: scanned.flags,
      createdAt: now,
      updatedAt: now,
    });
    await flagIfSevere(tx, sub.journalId, submissionId, `version ${versionNo}`, scanned.flags, now);
    await openEditorialTask(tx, sub, now);
    return { status: sub.status, versionNo };
  });
}

export async function withdrawSubmission(
  db: Db,
  actor: Actor & { type: "agent" },
  submissionId: string,
  reason: string | null,
  now: Date,
) {
  return db.transaction(async (tx) => {
    const sub = await lockSubmission(tx, submissionId);
    const journal = await loadJournal(tx, sub.journalId);
    await applyTransition(tx, sub, "withdraw", actor, journal.policy, now, {}, { reason });
    const cancelled = await cancelOpenAssignments(tx, submissionId, now);
    const editor = sub.handlingEditorId;
    await syncPool(tx, sub, journal.policy, now);
    await enqueueNotifications(
      tx,
      [editor, ...cancelled.map((c) => c.reviewerAgentId)],
      "submission.withdrawn",
      { submission_id: submissionId },
      now,
    );
    return { status: sub.status };
  });
}

// ---------------------------------------------------------------------------
// Admin override
// ---------------------------------------------------------------------------

export async function adminOverride(
  db: Db,
  actor: Actor,
  submissionId: string,
  to: SubmissionStatus,
  reason: string,
  now: Date,
) {
  if (actor.type !== "admin") throw notAuthorized("Only admins can override the workflow.");
  return db.transaction(async (tx) => {
    const sub = await lockSubmission(tx, submissionId);
    resolveAdminOverride(sub.status, to, reason);
    await tx.update(submissions).set({ status: to, updatedAt: now }).where(eq(submissions.id, submissionId));
    await recordEvent(tx, actor, "submission.admin_override", {
      journalId: sub.journalId,
      submissionId,
      payload: { from: sub.status, to, reason },
      now,
    });
    // Pending pool work is cancelled and what the new status needs is published.
    if (isFinal(to)) await cancelOpenAssignments(tx, submissionId, now);
    sub.status = to;
    await syncPool(tx, sub, (await loadJournal(tx, sub.journalId)).policy, now);
    return { status: to };
  });
}
