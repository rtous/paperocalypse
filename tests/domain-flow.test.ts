import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { articles, events, poolTasks, reviewAssignments, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { grantRoles, issueApiKey, revokeApiKey, setAgentStatus, verifyApiKey } from "@/lib/domain/agents";
import { loadBundle } from "@/lib/domain/bundle";
import { serializeForAuthor } from "@/lib/domain/blinding";
import { DomainError } from "@/lib/domain/errors";
import { listInbox } from "@/lib/domain/pool";
import {
  adminOverride,
  deskReject,
  makeDecision,
  sendToReview,
  submitManuscript,
  submitReview,
  submitRevision,
  withdrawSubmission,
} from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import {
  LETTER,
  T0,
  agentFor,
  createAdmin,
  createJournal,
  createMember,
  decide,
  hours,
  manuscript,
  review,
  sendOut,
  takeReview,
  takeTask,
} from "./helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let admin: Actor & { type: "admin" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
});
afterAll(async () => close());

async function expectCode(p: Promise<unknown>, code: DomainError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

async function status(id: string) {
  const [s] = await db.select({ status: submissions.status }).from(submissions).where(eq(submissions.id, id));
  return s!.status;
}

async function inboxKinds(agentId: string) {
  return (await listInbox(db, [agentId])).map((t) => t.kind);
}

/** Open (unclaimed) pool tasks of a submission, by kind. */
async function openPool(submissionId: string) {
  const rows = await db
    .select({ kind: poolTasks.kind })
    .from(poolTasks)
    .where(and(eq(poolTasks.submissionId, submissionId), eq(poolTasks.status, "open")));
  return rows.map((r) => r.kind).sort();
}

/** A journal with one editorial agent, two authors and four reviewers (all reviewers may edit: new operators score 5). */
async function setup(policy: Parameters<typeof createJournal>[1] = {}) {
  const journal = await createJournal(db, policy);
  const editor = await createMember(db, admin, journal.id, ["reviewer"], { name: "Editor" });
  const author = await createMember(db, admin, journal.id, ["author"], { name: "Author" });
  const coauthor = await createMember(db, admin, journal.id, ["author", "reviewer"], { name: "Coauthor" });
  const reviewers = [];
  for (let i = 1; i <= 4; i++) {
    reviewers.push(await createMember(db, admin, journal.id, ["reviewer"], { name: `Reviewer${i}` }));
  }
  return { journal, editor, author, coauthor, reviewers };
}

/** Submit, send to review and collect two reviews (status awaiting_decision). */
async function toAwaitingDecision(ctx: Awaited<ReturnType<typeof setup>>, now = T0) {
  const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), now);
  await sendOut(db, ctx.editor, ctx.journal.id, submissionId, now);
  const assignments: string[] = [];
  for (const r of ctx.reviewers.slice(0, 2)) {
    const id = await takeReview(db, r, ctx.journal.id, submissionId, hours(1, now));
    await submitReview(db, r, id, review(), hours(2, now));
    assignments.push(id);
  }
  return { submissionId, assignments };
}

describe("submission → publication happy path with two revision rounds", () => {
  it("runs the full cycle through the pool and keeps tasks and events in sync", async () => {
    const ctx = await setup({ open_review: true, blinding: "double" });
    const { author, editor, reviewers } = ctx;
    const J = ctx.journal.id;

    const { submissionId, status: s0 } = await submitManuscript(db, author, J, manuscript(), T0);
    expect(s0).toBe("with_editor");
    expect(await openPool(submissionId)).toEqual(["editorial"]);
    expect(await inboxKinds(editor.agentId)).toEqual([]);

    // The editorial agent takes the screening task and sends the paper to review.
    await takeTask(db, editor, J, "editorial", submissionId, T0);
    expect(await inboxKinds(editor.agentId)).toEqual(["editorial"]);
    expect((await loadBundle(db, submissionId))!.submission.handling_editor!.id).toBe(editor.agentId);
    const sent = await sendToReview(db, editor, submissionId, T0);
    expect(sent.reviewTasks).toBe(2);
    expect(await status(submissionId)).toBe("under_review");
    expect(await inboxKinds(editor.agentId)).toEqual([]);
    expect((await loadBundle(db, submissionId))!.submission.handling_editor).toBeNull();
    expect(await openPool(submissionId)).toEqual(["review", "review"]);

    // Two reviewers take the review tasks and submit.
    for (const r of reviewers.slice(0, 2)) {
      const id = await takeReview(db, r, J, submissionId, hours(1));
      expect(await inboxKinds(r.agentId)).toEqual(["write_review"]);
      await submitReview(db, r, id, review(), hours(2));
      expect(await inboxKinds(r.agentId)).toEqual([]);
    }
    expect(await status(submissionId)).toBe("awaiting_decision");
    expect(await openPool(submissionId)).toEqual(["editorial"]);

    // Round 1: major revision. The decision goes to an editorial agent through the pool.
    await decide(db, editor, J, submissionId, "major_revision", hours(3));
    expect(await status(submissionId)).toBe("revision_requested");
    const [authorTask] = await listInbox(db, [author.agentId]);
    expect(authorTask!.kind).toBe("revise_submission");
    expect(authorTask!.due_at?.toISOString()).toBe(hours(3 + 24 * 14).toISOString());
    expect(authorTask!.tool).toBe("submit_revision");

    // Authors see the reviews now (decision made), without reviewer identities.
    const authorView = serializeForAuthor((await loadBundle(db, submissionId))!, "double");
    expect(authorView.reviews).toHaveLength(2);
    expect(JSON.stringify(authorView)).not.toContain("CONFIDENTIAL-NOTE");
    expect(JSON.stringify(authorView)).not.toContain("Reviewer1");

    // Revision 1 → handling the revision is an editorial task → another review round → minor revision.
    await submitRevision(db, author, submissionId, { ...manuscript({ title: "v2" }), responseToReviewersMd: "Fixed." }, hours(4));
    expect(await status(submissionId)).toBe("with_editor");
    expect(await inboxKinds(author.agentId)).toEqual([]);
    await sendOut(db, editor, J, submissionId, hours(5));
    // Reviewers may review a new version again.
    for (const r of [reviewers[0]!, reviewers[2]!]) {
      await submitReview(db, r, await takeReview(db, r, J, submissionId, hours(6)), review(), hours(7));
    }
    expect(await status(submissionId)).toBe("awaiting_decision");
    await decide(db, editor, J, submissionId, "minor_revision", hours(8));

    // Revision 2 → the editor decides directly (no new round). max_revisions (2) reached.
    await submitRevision(db, author, submissionId, { ...manuscript({ title: "v3" }), responseToReviewersMd: "Done." }, hours(9));
    await takeTask(db, editor, J, "editorial", submissionId, hours(10));
    await expectCode(makeDecision(db, editor, submissionId, "minor_revision", LETTER, hours(10)), "INVALID_STATE");
    const accepted = await makeDecision(db, editor, submissionId, "accept", LETTER, hours(10));
    // Acceptance publishes immediately.
    expect(accepted.status).toBe("published");
    expect(accepted.article!.articleNo).toBe(1);
    expect(accepted.article!.publicId).toBe(`paperocalypse:${ctx.journal.slug}.2026.1`);
    expect(await status(submissionId)).toBe("published");
    expect(await inboxKinds(editor.agentId)).toEqual([]);
    expect(await openPool(submissionId)).toEqual([]);

    const [article] = await db.select().from(articles).where(eq(articles.id, accepted.article!.articleId));
    expect(article!.title).toBe("v3");
    expect(article!.versionNo).toBe(3);
    expect(article!.volume).toBe(1);
    expect(article!.reviewFile!.rounds).toHaveLength(3);
    expect(JSON.stringify(article!.reviewFile)).not.toContain("CONFIDENTIAL-NOTE");
    expect(JSON.stringify(article!.reviewFile)).not.toContain("Reviewer1"); // double blind → anonymous

    // Full-text search over the generated tsvector.
    const hits = await db
      .select({ id: articles.id })
      .from(articles)
      .where(sql`${articles.searchVector} @@ plainto_tsquery('english', 'deadlines')`);
    expect(hits.map((h) => h.id)).toContain(article!.id);

    // Every transition was logged, including the pool claims.
    const actions = (await db.select({ a: events.action }).from(events).where(eq(events.submissionId, submissionId))).map(
      (e) => e.a,
    );
    for (const a of [
      "submission.submitted",
      "pool.task_claimed",
      "submission.send_to_review",
      "submission.reviews_complete",
      "submission.decide_major_revision",
      "submission.submit_revision",
      "submission.decide_minor_revision",
      "submission.decide_accept",
      "submission.publish",
      "article.published",
    ]) {
      expect(actions).toContain(a);
    }

    // Second article gets number 2.
    const second = await toAwaitingDecision(ctx, hours(20));
    const r2 = await decide(db, editor, J, second.submissionId, "accept", hours(30));
    expect(r2.article!.articleNo).toBe(2);
  });
});

describe("authorization", () => {
  it("only the agent holding the editorial task (or an admin) can act as editor", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    // Nobody holds the task yet: agents can't act.
    await expectCode(deskReject(db, ctx.editor, submissionId, LETTER, T0), "NOT_FOUND");
    await takeTask(db, ctx.editor, ctx.journal.id, "editorial", submissionId, T0);
    await expectCode(deskReject(db, ctx.reviewers[0]!, submissionId, LETTER, T0), "NOT_FOUND");
    await expectCode(deskReject(db, ctx.author, submissionId, LETTER, T0), "NOT_AUTHORIZED");
    await deskReject(db, admin, submissionId, LETTER, T0);
    expect(await status(submissionId)).toBe("rejected");
    // The admin acted, so the agent's task was cancelled (unpaid) and left its inbox.
    expect(await inboxKinds(ctx.editor.agentId)).toEqual([]);
  });

  it("reviewers cannot touch assignments that are not theirs", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await sendOut(db, ctx.editor, ctx.journal.id, submissionId, T0);
    const id = await takeReview(db, ctx.reviewers[0]!, ctx.journal.id, submissionId, T0);
    await expectCode(submitReview(db, ctx.reviewers[1]!, id, review(), T0), "NOT_FOUND");
  });

  it("a decision needs min_reviews_for_decision reviews", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    // On version 1 the editor cannot decide straight from with_editor.
    await takeTask(db, ctx.editor, ctx.journal.id, "editorial", submissionId, T0);
    await expectCode(makeDecision(db, ctx.editor, submissionId, "accept", LETTER, T0), "INVALID_STATE");
    await sendToReview(db, ctx.editor, submissionId, T0);
    // Under review there is no editorial task to hold; admins still can't decide before the reviews.
    await expectCode(makeDecision(db, admin, submissionId, "accept", LETTER, T0), "INVALID_STATE");
  });
});

describe("desk reject, rejection and withdrawal", () => {
  it("desk reject finishes the editorial task and records a decision", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await takeTask(db, ctx.editor, ctx.journal.id, "editorial", submissionId, T0);
    await deskReject(db, ctx.editor, submissionId, LETTER, T0);
    expect(await status(submissionId)).toBe("rejected");
    expect(await inboxKinds(ctx.editor.agentId)).toEqual([]);
    const [task] = await db.select().from(poolTasks).where(eq(poolTasks.submissionId, submissionId));
    expect(task).toMatchObject({ status: "done", claimedByAgentId: ctx.editor.agentId });
    const b = (await loadBundle(db, submissionId))!;
    expect(b.decisions.map((d) => d.decision)).toEqual(["desk_reject"]);
    // Final: nothing else is possible.
    await expectCode(withdrawSubmission(db, ctx.author, submissionId, null, T0), "INVALID_STATE");
  });

  it("reject after review", async () => {
    const ctx = await setup();
    const { submissionId } = await toAwaitingDecision(ctx);
    await decide(db, ctx.editor, ctx.journal.id, submissionId, "reject", hours(3));
    expect(await status(submissionId)).toBe("rejected");
  });

  it("withdrawal cancels unfinished reviews and pending pool tasks", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await sendOut(db, ctx.editor, ctx.journal.id, submissionId, T0);
    const id = await takeReview(db, ctx.reviewers[0]!, ctx.journal.id, submissionId, hours(1));

    // Only the submitting author may withdraw.
    await expectCode(withdrawSubmission(db, ctx.reviewers[0]!, submissionId, null, hours(2)), "NOT_FOUND");
    await withdrawSubmission(db, ctx.author, submissionId, "Found a bug", hours(2));
    expect(await status(submissionId)).toBe("withdrawn");
    const [a] = await db.select().from(reviewAssignments).where(eq(reviewAssignments.id, id));
    expect(a!.status).toBe("cancelled");
    const pending = await db
      .select()
      .from(poolTasks)
      .where(and(eq(poolTasks.submissionId, submissionId), inArray(poolTasks.status, ["open", "claimed"])));
    expect(pending).toEqual([]);
    expect(await inboxKinds(ctx.reviewers[0]!.agentId)).toEqual([]);
  });
});

describe("reviews", () => {
  it("can be edited until the editor decides", async () => {
    const ctx = await setup();
    const { submissionId, assignments } = await toAwaitingDecision(ctx);
    const r0 = ctx.reviewers[0]!;
    const res = await submitReview(db, r0, assignments[0]!, review({ summaryMd: "Edited" }), hours(3));
    expect(res.edited).toBe(true);
    await decide(db, ctx.editor, ctx.journal.id, submissionId, "accept", hours(4));
    await expectCode(submitReview(db, r0, assignments[0]!, review(), hours(5)), "INVALID_STATE");
  });

  it("validates scores", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await sendOut(db, ctx.editor, ctx.journal.id, submissionId, T0);
    const id = await takeReview(db, ctx.reviewers[0]!, ctx.journal.id, submissionId, T0);
    await expectCode(submitReview(db, ctx.reviewers[0]!, id, review({ confidence: 9 }), T0), "VALIDATION_ERROR");
  });

  it("extra review slots nobody took are cancelled once enough reviews are in", async () => {
    const ctx = await setup({ reviewers_per_submission: 3, min_reviews_for_decision: 2 });
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await sendOut(db, ctx.editor, ctx.journal.id, submissionId, T0);
    expect(await openPool(submissionId)).toEqual(["review", "review", "review"]);
    for (const r of ctx.reviewers.slice(0, 2)) {
      await submitReview(db, r, await takeReview(db, r, ctx.journal.id, submissionId, T0), review(), hours(1));
    }
    expect(await status(submissionId)).toBe("awaiting_decision");
    expect(await openPool(submissionId)).toEqual(["editorial"]);
  });
});

describe("submission limits", () => {
  it("enforces max_manuscript_chars, open submissions and the daily limit", async () => {
    const ctx = await setup({ max_manuscript_chars: 1000, max_open_submissions_per_agent: 2, max_submissions_per_agent_per_day: 3 });
    await expectCode(
      submitManuscript(db, ctx.author, ctx.journal.id, manuscript({ bodyMd: "x".repeat(1001) }), T0),
      "VALIDATION_ERROR",
    );
    const a = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await expectCode(submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0), "RATE_LIMITED");
    await withdrawSubmission(db, ctx.author, a.submissionId, null, T0);
    await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0); // 3rd today, 2 open
    await withdrawSubmission(db, ctx.author, (await submitManuscriptIds(ctx))[0]!, null, T0);
    const err = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.details.retry_after_seconds).toBeGreaterThan(0);
  });

  it("requires membership, an open journal, co-authors who are members and an AI disclosure", async () => {
    const ctx = await setup();
    const outsider = await createMember(db, admin, (await createJournal(db)).id, ["author"]);
    await expectCode(submitManuscript(db, outsider, ctx.journal.id, manuscript(), T0), "NOT_AUTHORIZED");
    await expectCode(
      submitManuscript(db, ctx.author, ctx.journal.id, manuscript({ coAuthorAgentIds: [outsider.agentId] }), T0),
      "VALIDATION_ERROR",
    );
    await expectCode(submitManuscript(db, ctx.author, ctx.journal.id, manuscript({ aiDisclosure: " " }), T0), "VALIDATION_ERROR");
    await db.execute(sql`update journals set status = 'closed' where id = ${ctx.journal.id}`);
    await expectCode(submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0), "INVALID_STATE");
  });

  async function submitManuscriptIds(ctx: Awaited<ReturnType<typeof setup>>) {
    const rows = await db
      .select({ id: submissions.id })
      .from(submissions)
      .where(and(eq(submissions.submittingAgentId, ctx.author.agentId), eq(submissions.status, "with_editor")));
    return rows.map((r) => r.id);
  }
});

describe("admin override", () => {
  it("moves a submission anywhere, logs the reason, and brings the pool in line", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await takeTask(db, ctx.editor, ctx.journal.id, "editorial", submissionId, T0);
    await expectCode(adminOverride(db, ctx.editor, submissionId, "rejected", "because", T0), "NOT_AUTHORIZED");
    // Back under review: the editorial task is cancelled and review tasks are published.
    await adminOverride(db, admin, submissionId, "under_review", "Skip screening", T0);
    expect(await inboxKinds(ctx.editor.agentId)).toEqual([]);
    expect(await openPool(submissionId)).toEqual(["review", "review"]);
    await adminOverride(db, admin, submissionId, "rejected", "Spam submission", T0);
    expect(await status(submissionId)).toBe("rejected");
    expect(await openPool(submissionId)).toEqual([]);
    const overrides = await db
      .select()
      .from(events)
      .where(and(eq(events.submissionId, submissionId), eq(events.action, "submission.admin_override")));
    const e = overrides.find((x) => (x.payload as { to?: string }).to === "rejected");
    expect(e!.payload).toMatchObject({ from: "under_review", to: "rejected", reason: "Spam submission" });
    expect(e!.actorType).toBe("admin");
  });
});

describe("events are append-only", () => {
  it("rejects UPDATE and DELETE", async () => {
    const causeOf = (p: Promise<unknown>) => p.then(() => null, (e: Error) => String((e.cause as Error | undefined)?.message ?? e.message));
    expect(await causeOf(db.execute(sql`update events set action = 'x'`))).toMatch(/append-only/);
    expect(await causeOf(db.execute(sql`delete from events`))).toMatch(/append-only/);
  });
});

describe("API keys", () => {
  it("issues, verifies and revokes keys; suspended agents are rejected", async () => {
    const agent = await agentFor(db, admin, "Keyed");
    const { apiKey, keyId, keyPrefix } = await issueApiKey(db, admin, agent.id, "main", T0);
    expect(apiKey.startsWith("pk_live_")).toBe(true);
    expect(apiKey.slice(8, 16)).toBe(keyPrefix);

    expect(await verifyApiKey(db, apiKey, T0)).toEqual({ agentId: agent.id, keyId });
    expect(await verifyApiKey(db, apiKey + "x", T0)).toBeNull();
    expect(await verifyApiKey(db, "nope", T0)).toBeNull();

    // The plain key is never stored.
    const stored = await db.execute(sql`select key_hash from api_keys where id = ${keyId}`);
    expect(JSON.stringify(stored)).not.toContain(apiKey);

    await setAgentStatus(db, admin, agent.id, "suspended", T0);
    expect(await verifyApiKey(db, apiKey, T0)).toBeNull();
    await setAgentStatus(db, admin, agent.id, "active", T0);
    await revokeApiKey(db, admin, keyId, T0);
    expect(await verifyApiKey(db, apiKey, T0)).toBeNull();
  });

  it("only admins grant roles", async () => {
    const j = await createJournal(db);
    const agent = await agentFor(db, admin, "x");
    await expectCode(grantRoles(db, { type: "agent", agentId: agent.id }, j.id, agent.id, ["reviewer"], T0), "NOT_AUTHORIZED");
  });
});
