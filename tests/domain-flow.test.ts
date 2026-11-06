import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { articles, events, reviewAssignments, submissions, tasks } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { createAgent, grantRoles, issueApiKey, revokeApiKey, setAgentStatus, verifyApiKey } from "@/lib/domain/agents";
import { loadBundle } from "@/lib/domain/bundle";
import { serializeForAuthor } from "@/lib/domain/blinding";
import { processDeadlines } from "@/lib/domain/deadlines";
import { DomainError } from "@/lib/domain/errors";
import {
  adminOverride,
  assignEditor,
  deskReject,
  inviteReviewers,
  makeDecision,
  publishArticle,
  respondToInvitation,
  submitManuscript,
  submitReview,
  submitRevision,
  withdrawSubmission,
} from "@/lib/domain/submissions";
import { listOpenTasks } from "@/lib/domain/tasks";
import { createTestDb } from "./helpers/db";
import { LETTER, T0, createAdmin, createJournal, createMember, hours, manuscript, review } from "./helpers/fixtures";

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

async function openKinds(agentId: string) {
  return (await listOpenTasks(db, agentId)).map((t) => t.kind);
}

/** A journal with one editor, two authors and four reviewers. */
async function setup(policy: Parameters<typeof createJournal>[1] = {}) {
  const journal = await createJournal(db, policy);
  const editor = await createMember(db, admin, journal.id, ["editor"], { name: "Editor" });
  const author = await createMember(db, admin, journal.id, ["author"], { name: "Author" });
  const coauthor = await createMember(db, admin, journal.id, ["author", "reviewer"], { name: "Coauthor" });
  const reviewers = [];
  for (let i = 1; i <= 4; i++) {
    reviewers.push(await createMember(db, admin, journal.id, ["reviewer"], { name: `Reviewer${i}` }));
  }
  return { journal, editor, author, coauthor, reviewers };
}

/** Submit and drive to awaiting_decision with two reviews. */
async function toAwaitingDecision(ctx: Awaited<ReturnType<typeof setup>>, now = T0) {
  const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), now);
  const { assignments } = await inviteReviewers(
    db,
    ctx.editor,
    submissionId,
    [ctx.reviewers[0]!.agentId, ctx.reviewers[1]!.agentId],
    now,
  );
  for (const [i, a] of assignments.entries()) {
    const reviewer = ctx.reviewers[i]!;
    await respondToInvitation(db, reviewer, a.assignmentId, true, null, hours(1, now));
    await submitReview(db, reviewer, a.assignmentId, review(), hours(2, now));
  }
  return { submissionId, assignments };
}

describe("submission → publication happy path with two revision rounds", () => {
  it("runs the full cycle and keeps tasks and events in sync", async () => {
    const ctx = await setup({ open_review: true, blinding: "double" });
    const { author, editor, reviewers } = ctx;

    const { submissionId, status: s0 } = await submitManuscript(db, author, ctx.journal.id, manuscript(), T0);
    expect(s0).toBe("with_editor");
    expect(await openKinds(editor.agentId)).toEqual(["screen_submission"]);

    const { assignments } = await inviteReviewers(
      db,
      editor,
      submissionId,
      [reviewers[0]!.agentId, reviewers[1]!.agentId],
      T0,
    );
    expect(await status(submissionId)).toBe("under_review");
    expect(await openKinds(editor.agentId)).toEqual([]);
    expect(await openKinds(reviewers[0]!.agentId)).toEqual(["respond_to_invitation"]);

    // Reviewer 1 accepts and reviews, reviewer 2 too.
    for (const [i, a] of assignments.entries()) {
      await respondToInvitation(db, reviewers[i]!, a.assignmentId, true, null, hours(1));
      expect(await openKinds(reviewers[i]!.agentId)).toEqual(["write_review"]);
      await submitReview(db, reviewers[i]!, a.assignmentId, review(), hours(2));
      expect(await openKinds(reviewers[i]!.agentId)).toEqual([]);
    }
    expect(await status(submissionId)).toBe("awaiting_decision");
    expect(await openKinds(editor.agentId)).toEqual(["make_decision"]);

    // Round 1: major revision.
    await makeDecision(db, editor, submissionId, "major_revision", LETTER, hours(3));
    expect(await status(submissionId)).toBe("revision_requested");
    expect(await openKinds(author.agentId)).toEqual(["revise_submission"]);
    const [authorTask] = await listOpenTasks(db, author.agentId);
    expect(authorTask!.due_at?.toISOString()).toBe(hours(3 + 24 * 14).toISOString());
    expect(authorTask!.tool).toBe("submit_revision");

    // Authors see the reviews now (decision made), without reviewer identities.
    const authorView = serializeForAuthor((await loadBundle(db, submissionId))!, "double");
    expect(authorView.reviews).toHaveLength(2);
    expect(JSON.stringify(authorView)).not.toContain("CONFIDENTIAL-NOTE");
    expect(JSON.stringify(authorView)).not.toContain("Reviewer1");

    // Revision 1 → re-review → minor revision.
    await submitRevision(db, author, submissionId, { ...manuscript({ title: "v2" }), responseToReviewersMd: "Fixed." }, hours(4));
    expect(await status(submissionId)).toBe("with_editor");
    expect(await openKinds(editor.agentId)).toEqual(["handle_revision"]);
    const round2 = await inviteReviewers(db, editor, submissionId, [reviewers[0]!.agentId, reviewers[2]!.agentId], hours(5));
    for (const [i, a] of round2.assignments.entries()) {
      const r = i === 0 ? reviewers[0]! : reviewers[2]!;
      await respondToInvitation(db, r, a.assignmentId, true, null, hours(6));
      await submitReview(db, r, a.assignmentId, review(), hours(7));
    }
    expect(await status(submissionId)).toBe("awaiting_decision");
    await makeDecision(db, editor, submissionId, "minor_revision", LETTER, hours(8));

    // Revision 2 → editor decides directly (no new review round). max_revisions (2) reached.
    await submitRevision(db, author, submissionId, { ...manuscript({ title: "v3" }), responseToReviewersMd: "Done." }, hours(9));
    await expectCode(makeDecision(db, editor, submissionId, "minor_revision", LETTER, hours(10)), "INVALID_STATE");
    await makeDecision(db, editor, submissionId, "accept", LETTER, hours(10));
    expect(await status(submissionId)).toBe("accepted");
    expect(await openKinds(editor.agentId)).toEqual(["publish_article"]);

    const pub = await publishArticle(db, editor, submissionId, hours(11));
    expect(pub.articleNo).toBe(1);
    expect(pub.publicId).toBe(`paperocalypse:${ctx.journal.slug}.2026.1`);
    expect(await status(submissionId)).toBe("published");
    expect(await openKinds(editor.agentId)).toEqual([]);

    const [article] = await db.select().from(articles).where(eq(articles.id, pub.articleId));
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
    expect(hits.map((h) => h.id)).toContain(pub.articleId);

    // Every transition was logged.
    const actions = (await db.select({ a: events.action }).from(events).where(eq(events.submissionId, submissionId))).map(
      (e) => e.a,
    );
    for (const a of [
      "submission.submitted",
      "submission.assign_editor",
      "submission.invite_reviewers",
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
    await makeDecision(db, editor, second.submissionId, "accept", LETTER, hours(30));
    expect((await publishArticle(db, editor, second.submissionId, hours(31))).articleNo).toBe(2);
  });
});

describe("editor assignment", () => {
  it("round-robins between editors and skips conflicted ones", async () => {
    const journal = await createJournal(db);
    const e1 = await createMember(db, admin, journal.id, ["editor"]);
    const e2 = await createMember(db, admin, journal.id, ["editor"]);
    const author = await createMember(db, admin, journal.id, ["author"]);

    const s1 = await submitManuscript(db, author, journal.id, manuscript(), T0);
    const s2 = await submitManuscript(db, author, journal.id, manuscript(), hours(1));
    const s3 = await submitManuscript(db, author, journal.id, manuscript(), hours(2));
    const editors = await Promise.all(
      [s1, s2, s3].map(async (s) => (await loadBundle(db, s.submissionId))!.submission.handling_editor!.id),
    );
    expect(editors).toEqual([e1.agentId, e2.agentId, e1.agentId]);
  });

  it("never assigns an editor who is an author, and waits when nobody is available", async () => {
    const journal = await createJournal(db);
    const editorAuthor = await createMember(db, admin, journal.id, ["editor", "author"]);
    const { submissionId, status: s } = await submitManuscript(db, editorAuthor, journal.id, manuscript(), T0);
    expect(s).toBe("submitted");

    // A new editor appears; the cron tick assigns it.
    const e2 = await createMember(db, admin, journal.id, ["editor"]);
    const r = await processDeadlines(db, hours(1));
    expect(r.editorsAssigned).toBeGreaterThanOrEqual(1);
    const b = (await loadBundle(db, submissionId))!;
    expect(b.submission.status).toBe("with_editor");
    expect(b.submission.handling_editor!.id).toBe(e2.agentId);
  });

  it("skips editors sharing an operator with an author", async () => {
    const journal = await createJournal(db);
    await createMember(db, admin, journal.id, ["editor"], { operatorContact: "same@op.org" });
    const author = await createMember(db, admin, journal.id, ["author"], { operatorContact: "SAME@op.org" });
    const { status: s } = await submitManuscript(db, author, journal.id, manuscript(), T0);
    expect(s).toBe("submitted");
  });

  it("agents cannot assign editors", async () => {
    const ctx = await setup();
    await expectCode(assignEditor(db, ctx.author, "00000000-0000-0000-0000-000000000000", T0), "NOT_AUTHORIZED");
  });
});

describe("conflicts of interest on reviewer invitations", () => {
  it("rejects authors, same-operator agents and recent co-authors", async () => {
    const ctx = await setup();
    const sameOp = await createMember(db, admin, ctx.journal.id, ["reviewer"]);
    // Give sameOp the author's operator contact.
    const [authorAgent] = await db.execute<{ operator_contact_normalized: string }>(
      sql`select operator_contact_normalized from agents where id = ${ctx.author.agentId}`,
    ).then((r) => (r as unknown as { rows: { operator_contact_normalized: string }[] }).rows);
    await db.execute(sql`update agents set operator_contact_normalized = ${authorAgent!.operator_contact_normalized} where id = ${sameOp.agentId}`);

    // An earlier paper co-authored by author + coauthor makes coauthor conflicted.
    await submitManuscript(db, ctx.author, ctx.journal.id, manuscript({ coAuthorAgentIds: [ctx.coauthor.agentId] }), T0);
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), hours(1));

    await expectCode(inviteReviewers(db, ctx.editor, submissionId, [sameOp.agentId], hours(2)), "CONFLICT_OF_INTEREST");
    await expectCode(inviteReviewers(db, ctx.editor, submissionId, [ctx.coauthor.agentId], hours(2)), "CONFLICT_OF_INTEREST");
    // Non-reviewer (the author has no reviewer role) is a validation error.
    await expectCode(inviteReviewers(db, ctx.editor, submissionId, [ctx.author.agentId], hours(2)), "VALIDATION_ERROR");
    // A clean reviewer is fine.
    await inviteReviewers(db, ctx.editor, submissionId, [ctx.reviewers[0]!.agentId], hours(2));
  });

  it("the handling editor cannot review", async () => {
    const journal = await createJournal(db);
    const editor = await createMember(db, admin, journal.id, ["editor", "reviewer"]);
    const author = await createMember(db, admin, journal.id, ["author"]);
    const { submissionId } = await submitManuscript(db, author, journal.id, manuscript(), T0);
    await expectCode(inviteReviewers(db, editor, submissionId, [editor.agentId], T0), "CONFLICT_OF_INTEREST");
  });

  it("co-authorship older than the window is not a conflict", async () => {
    const ctx = await setup({ coi_coauthor_months: 12 });
    await submitManuscript(db, ctx.author, ctx.journal.id, manuscript({ coAuthorAgentIds: [ctx.coauthor.agentId] }), T0);
    const later = new Date("2027-06-01T00:00:00Z");
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), later);
    await inviteReviewers(db, ctx.editor, submissionId, [ctx.coauthor.agentId], later);
  });

  it("enforces reviewers_per_submission and no duplicate invitations", async () => {
    const ctx = await setup({ reviewers_per_submission: 2 });
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const ids = ctx.reviewers.map((r) => r.agentId);
    await expectCode(inviteReviewers(db, ctx.editor, submissionId, ids.slice(0, 3), T0), "VALIDATION_ERROR");
    await inviteReviewers(db, ctx.editor, submissionId, [ids[0]!], T0);
    await expectCode(inviteReviewers(db, ctx.editor, submissionId, [ids[0]!], T0), "VALIDATION_ERROR");
  });
});

describe("authorization", () => {
  it("only the handling editor (or an admin) can act as editor", async () => {
    const ctx = await setup();
    const other = await createMember(db, admin, ctx.journal.id, ["editor"]);
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const bundle = (await loadBundle(db, submissionId))!;
    const notHandling = bundle.submission.handling_editor!.id === other.agentId ? ctx.editor : other;
    await expectCode(deskReject(db, notHandling, submissionId, LETTER, T0), "NOT_FOUND");
    await expectCode(deskReject(db, ctx.author, submissionId, LETTER, T0), "NOT_AUTHORIZED");
    await deskReject(db, admin, submissionId, LETTER, T0);
    expect(await status(submissionId)).toBe("rejected");
  });

  it("reviewers cannot touch assignments that are not theirs", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const { assignments } = await inviteReviewers(db, ctx.editor, submissionId, [ctx.reviewers[0]!.agentId], T0);
    await expectCode(respondToInvitation(db, ctx.reviewers[1]!, assignments[0]!.assignmentId, true, null, T0), "NOT_FOUND");
  });

  it("a decision needs min_reviews_for_decision reviews", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await inviteReviewers(db, ctx.editor, submissionId, [ctx.reviewers[0]!.agentId], T0);
    await expectCode(makeDecision(db, ctx.editor, submissionId, "accept", LETTER, T0), "INVALID_STATE");
    // On version 1 the editor cannot decide straight from with_editor either.
    const s2 = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await expectCode(makeDecision(db, ctx.editor, s2.submissionId, "accept", LETTER, T0), "INVALID_STATE");
  });
});

describe("desk reject, rejection and withdrawal", () => {
  it("desk reject closes editor tasks and records a decision", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await deskReject(db, ctx.editor, submissionId, LETTER, T0);
    expect(await status(submissionId)).toBe("rejected");
    expect(await openKinds(ctx.editor.agentId)).toEqual([]);
    const b = (await loadBundle(db, submissionId))!;
    expect(b.decisions.map((d) => d.decision)).toEqual(["desk_reject"]);
    // Final: nothing else is possible.
    await expectCode(withdrawSubmission(db, ctx.author, submissionId, null, T0), "INVALID_STATE");
  });

  it("reject after review", async () => {
    const ctx = await setup();
    const { submissionId } = await toAwaitingDecision(ctx);
    await makeDecision(db, ctx.editor, submissionId, "reject", LETTER, hours(3));
    expect(await status(submissionId)).toBe("rejected");
  });

  it("withdrawal cancels open review assignments and closes all tasks", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const { assignments } = await inviteReviewers(db, ctx.editor, submissionId, [ctx.reviewers[0]!.agentId], T0);
    await respondToInvitation(db, ctx.reviewers[0]!, assignments[0]!.assignmentId, true, null, hours(1));

    // Only the submitting author may withdraw.
    await expectCode(withdrawSubmission(db, ctx.reviewers[0]!, submissionId, null, hours(2)), "NOT_FOUND");
    await withdrawSubmission(db, ctx.author, submissionId, "Found a bug", hours(2));
    expect(await status(submissionId)).toBe("withdrawn");
    const [a] = await db.select().from(reviewAssignments).where(eq(reviewAssignments.id, assignments[0]!.assignmentId));
    expect(a!.status).toBe("cancelled");
    const open = await db.select().from(tasks).where(and(eq(tasks.submissionId, submissionId), eq(tasks.status, "open")));
    expect(open).toEqual([]);
  });
});

describe("reviews", () => {
  it("can be edited until the editor decides", async () => {
    const ctx = await setup();
    const { submissionId, assignments } = await toAwaitingDecision(ctx);
    const r0 = ctx.reviewers[0]!;
    const res = await submitReview(db, r0, assignments[0]!.assignmentId, review({ summaryMd: "Edited" }), hours(3));
    expect(res.edited).toBe(true);
    await makeDecision(db, ctx.editor, submissionId, "accept", LETTER, hours(4));
    await expectCode(submitReview(db, r0, assignments[0]!.assignmentId, review(), hours(5)), "INVALID_STATE");
  });

  it("must be accepted first and validates scores", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const { assignments } = await inviteReviewers(db, ctx.editor, submissionId, [ctx.reviewers[0]!.agentId], T0);
    const id = assignments[0]!.assignmentId;
    await expectCode(submitReview(db, ctx.reviewers[0]!, id, review(), T0), "INVALID_STATE");
    await respondToInvitation(db, ctx.reviewers[0]!, id, true, null, T0);
    await expectCode(
      submitReview(db, ctx.reviewers[0]!, id, review({ confidence: 9 }), T0),
      "VALIDATION_ERROR",
    );
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
  it("moves a submission anywhere, logs the reason, and cleans up on final states", async () => {
    const ctx = await setup();
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    await expectCode(adminOverride(db, ctx.editor, submissionId, "rejected", "because", T0), "NOT_AUTHORIZED");
    await adminOverride(db, admin, submissionId, "rejected", "Spam submission", T0);
    expect(await status(submissionId)).toBe("rejected");
    expect(await openKinds(ctx.editor.agentId)).toEqual([]);
    const [e] = await db
      .select()
      .from(events)
      .where(and(eq(events.submissionId, submissionId), eq(events.action, "submission.admin_override")));
    expect(e!.payload).toMatchObject({ from: "with_editor", to: "rejected", reason: "Spam submission" });
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
    const agent = await createAgent(db, admin, { displayName: "Keyed" }, T0);
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
    const agent = await createAgent(db, admin, { displayName: "x" }, T0);
    await expectCode(grantRoles(db, { type: "agent", agentId: agent.id }, j.id, agent.id, ["editor"], T0), "NOT_AUTHORIZED");
  });
});
