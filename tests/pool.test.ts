import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, papercoinTransactions, poolTasks, reviewAssignments } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { DomainError } from "@/lib/domain/errors";
import { listInbox, poolStanding, releaseTask, requestTask, reviewQuota } from "@/lib/domain/pool";
import { deskReject, sendToReview, submitManuscript, submitReview } from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import { LETTER, T0, createAdmin, createJournal, createMember, hours, manuscript, review, sendOut, takeReview, takeTask } from "./helpers/fixtures";

// Reviewer scores are set per operator here; everyone else keeps the starting score of 5.
const scores = vi.hoisted(() => new Map<string, number>());
vi.mock("@/lib/domain/reputation", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/domain/reputation")>();
  return {
    ...real,
    operatorReputation: async (_db: unknown, operatorId: string) => ({
      author: real.newAuthorScore(),
      reviewer: scores.has(operatorId)
        ? { score: scores.get(operatorId)!, isNew: false, scoredPapers: 1, meanError: 5 - scores.get(operatorId)! }
        : real.newReviewerScore(),
      averages: { authorFirstYear: null, paperFirstYear: null },
    }),
  };
});

let db: Db;
let close: () => Promise<void>;
let admin: Actor & { type: "admin" };
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
});
afterAll(async () => close());

type AgentActor = Actor & { type: "agent" };

async function operatorOf(a: AgentActor) {
  const [r] = await db.select({ op: agents.operatorId }).from(agents).where(eq(agents.id, a.agentId));
  return r!.op;
}

async function expectCode(p: Promise<unknown>, code: DomainError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

async function setup(policy: Parameters<typeof createJournal>[1] = {}) {
  const journal = await createJournal(db, { max_open_submissions_per_agent: 50, max_submissions_per_agent_per_day: 50, ...policy });
  const editor = await createMember(db, admin, journal.id, ["reviewer"], { name: "Editor" });
  const author = await createMember(db, admin, journal.id, ["author"], { name: "Author" });
  const reviewers: AgentActor[] = [];
  for (let i = 1; i <= 3; i++) reviewers.push(await createMember(db, admin, journal.id, ["reviewer"], { name: `R${i}` }));
  return { journal, J: journal.id, editor, author, reviewers };
}

describe("reviewQuota", () => {
  it("is 1 + 2 × score, rounded down", () => {
    expect([0, 0.4, 0.5, 1, 2.5, 3.99, 4.8, 5].map(reviewQuota)).toEqual([1, 1, 2, 3, 6, 8, 10, 11]);
  });
});

describe("request_task", () => {
  it("hands out the oldest task, one at a time, and returns the held task when asked again", async () => {
    const { J, author, reviewers } = await setup();
    const s1 = await submitManuscript(db, author, J, manuscript(), T0);
    const s2 = await submitManuscript(db, author, J, manuscript(), hours(1));
    const r = reviewers[0]!;
    const first = await requestTask(db, r, J, hours(2));
    expect(first.task).toMatchObject({ kind: "editorial", submissionId: s1.submissionId, status: "claimed" });
    expect(first.task!.dueAt!.toISOString()).toBe(hours(2 + 48).toISOString());
    const again = await requestTask(db, r, J, hours(3));
    expect(again.task!.id).toBe(first.task!.id);
    expect((again as { alreadyHeld: boolean }).alreadyHeld).toBe(true);
    // Someone else gets the next one.
    const other = await requestTask(db, reviewers[1]!, J, hours(3));
    expect(other.task!.submissionId).toBe(s2.submissionId);
  });

  it("needs an active reviewer membership", async () => {
    const { J, author } = await setup();
    await expectCode(requestTask(db, author, J, T0), "VALIDATION_ERROR");
  });

  it("prefers reviews on the agent's topics", async () => {
    const { J, editor, author } = await setup();
    const off = await submitManuscript(db, author, J, manuscript({ keywords: ["botany"] }), T0);
    const on = await submitManuscript(db, author, J, manuscript({ keywords: ["entropy"] }), hours(1));
    await sendOut(db, editor, J, off.submissionId, hours(2));
    // The editor can't review what it screened, so a fresh editor screens the second one.
    const ed2 = await createMember(db, admin, J, ["reviewer"]);
    await sendOut(db, ed2, J, on.submissionId, hours(2));
    const topical = await createMember(db, admin, J, ["reviewer"]);
    await db.execute(sql`update journal_memberships set reviewer_topics = '{entropy}' where agent_id = ${topical.agentId}`);
    await takeReview(db, topical, J, on.submissionId, hours(3));
  });

  it("excludes conflicts of interest", async () => {
    const { J, editor, author } = await setup();
    const sameOp = await createMember(db, admin, J, ["reviewer"]);
    await db.execute(sql`update agents set operator_contact_normalized = (select operator_contact_normalized from agents where id = ${author.agentId}) where id = ${sameOp.agentId}`);
    const { submissionId } = await submitManuscript(db, author, J, manuscript(), T0);
    const r = await requestTask(db, sameOp, J, T0);
    expect(r.task).toBeNull();
    await sendOut(db, editor, J, submissionId, T0);
    expect((await requestTask(db, sameOp, J, T0)).task).toBeNull();
  });

  it("keeps each operator in one capacity per submission and reviewing each version once", async () => {
    const { J, editor, author, reviewers } = await setup({ reviewers_per_submission: 3 });
    const { submissionId } = await submitManuscript(db, author, J, manuscript(), T0);
    await sendOut(db, editor, J, submissionId, T0);
    // The screening editor's operator may not review it.
    const blocked = await requestTask(db, editor, J, T0);
    expect(blocked.task).toBeNull();
    expect((blocked as { reasons: string[] }).reasons[0]).toMatch(/may not take/);
    // A second agent of the same reviewer operator can't take a second slot on the same version.
    const r = reviewers[0]!;
    await takeReview(db, r, J, submissionId, T0);
    const sibling = await createMember(db, admin, J, ["reviewer"]);
    await db.update(agents).set({ operatorId: await operatorOf(r) }).where(eq(agents.id, sibling.agentId));
    expect((await requestTask(db, sibling, J, T0)).task).toBeNull();
  });

  it("reviewers of a submission don't get its editorial tasks", async () => {
    const { J, editor, author, reviewers } = await setup({ reviewers_per_submission: 2, min_reviews_for_decision: 2 });
    const { submissionId } = await submitManuscript(db, author, J, manuscript(), T0);
    await sendOut(db, editor, J, submissionId, T0);
    for (const r of reviewers.slice(0, 2)) await submitReview(db, r, await takeReview(db, r, J, submissionId, T0), review(), hours(1));
    // The decision is open; the reviewers can't take it, the editor (or anyone else) can.
    expect((await requestTask(db, reviewers[0]!, J, hours(2))).task).toBeNull();
    await takeTask(db, reviewers[2]!, J, "editorial", submissionId, hours(2));
  });

  it("gives editorial tasks only to operators with a reviewer score of 4 or more", async () => {
    const { J, author, reviewers } = await setup();
    const [low, high] = reviewers;
    scores.set(await operatorOf(low!), 3.9);
    scores.set(await operatorOf(high!), 4);
    const { submissionId } = await submitManuscript(db, author, J, manuscript(), T0);
    const r = await requestTask(db, low!, J, T0);
    expect(r.task).toBeNull();
    expect((r as { reasons: string[] }).reasons.join(" ")).toMatch(/at least 4\.0; your operator's is 3\.9/);
    expect(r.standing).toMatchObject({ editorialAllowed: false, reviewQuota: 8 });
    await takeTask(db, high!, J, "editorial", submissionId, T0);
  });

  it("limits reviews per operator and 30 days by reviewer score (releases count)", async () => {
    const { J, editor, author, reviewers } = await setup({ reviewers_per_submission: 1 });
    const r = reviewers[0]!;
    scores.set(await operatorOf(r), 0.5); // quota 2, no editorial tasks
    const subs = [];
    for (let i = 0; i < 3; i++) {
      const { submissionId } = await submitManuscript(db, author, J, manuscript(), hours(i));
      await sendOut(db, editor, J, submissionId, hours(i));
      subs.push(submissionId);
    }
    const t1 = await requestTask(db, r, J, hours(10));
    await releaseTask(db, r, t1.task!.id, "conflict", hours(10));
    // Released: the assignment is kept as "declined" and the slot is open again.
    const [a] = await db.select().from(reviewAssignments).where(eq(reviewAssignments.poolTaskId, t1.task!.id));
    expect(a).toMatchObject({ status: "declined", releaseReason: "conflict" });
    const t2 = await requestTask(db, r, J, hours(11));
    if (!t2.task) throw new Error("expected a task");
    expect(t2.task.submissionId).not.toBe(t1.task!.submissionId); // that version was already taken once
    await submitReview(db, r, t2.assignmentId!, review(), hours(12));
    const refused = await requestTask(db, r, J, hours(13));
    expect(refused.task).toBeNull();
    expect(refused.standing).toMatchObject({ reviewsInWindow: 2, reviewQuota: 2 });
    expect(refused.standing.nextReviewSlotAt!.toISOString()).toBe(hours(10 + 30 * 24).toISOString());
    // 30 days after the first claim, one slot frees up.
    const at = hours(10.5 + 30 * 24);
    const later = await requestTask(db, r, J, at);
    expect(later.task?.kind).toBe("review");
    expect((await poolStanding(db, await operatorOf(r), at)).reviewsInWindow).toBe(2);
  });
});

describe("release_task and payouts", () => {
  it("releasing an editorial task returns it to the pool and clears the handling editor", async () => {
    const { J, author, reviewers } = await setup();
    const { submissionId } = await submitManuscript(db, author, J, manuscript(), T0);
    const t = await takeTask(db, reviewers[0]!, J, "editorial", submissionId, T0);
    await expectCode(releaseTask(db, reviewers[1]!, t.task!.id, null, T0), "NOT_FOUND");
    await releaseTask(db, reviewers[0]!, t.task!.id, null, T0);
    await expectCode(releaseTask(db, reviewers[0]!, t.task!.id, null, T0), "NOT_FOUND");
    await expectCode(deskReject(db, reviewers[0]!, submissionId, LETTER, T0), "NOT_FOUND");
    expect(await listInbox(db, [reviewers[0]!.agentId])).toEqual([]);
    await takeTask(db, reviewers[1]!, J, "editorial", submissionId, T0);
  });

  it("each completed editorial task pays 1 papercoin to the agent's operator", async () => {
    const { J, editor, author } = await setup();
    const { submissionId } = await submitManuscript(db, author, J, manuscript(), T0);
    const t = await takeTask(db, editor, J, "editorial", submissionId, T0);
    await sendToReview(db, editor, submissionId, T0);
    const paid = await db
      .select()
      .from(papercoinTransactions)
      .where(and(eq(papercoinTransactions.refId, t.task!.id), eq(papercoinTransactions.reason, "editorial_decision")));
    expect(paid).toHaveLength(1);
    expect(paid[0]!.amount).toBe(1);
    const [done] = await db.select().from(poolTasks).where(eq(poolTasks.id, t.task!.id));
    expect(done!.status).toBe("done");
  });
});
