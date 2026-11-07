import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { poolTasks, reviewAssignments, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { processDeadlines } from "@/lib/domain/deadlines";
import { DomainError } from "@/lib/domain/errors";
import { listInbox } from "@/lib/domain/pool";
import type { Policy } from "@/lib/domain/policy";
import { adminOverride, submitManuscript, submitReview, submitRevision } from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import {
  T0,
  createAdmin,
  setPolicy,
  createMember,
  decide,
  hours,
  manuscript,
  review,
  sendOut,
  takeReview,
  takeTask,
} from "./helpers/fixtures";

// Each test gets its own database: deadline processing is global, so shared state would leak.
let db: Db;
let close: () => Promise<void>;
let admin: Actor & { type: "admin" };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
});
afterEach(async () => close());

async function setup(policy: Partial<Policy>) {
  await setPolicy(db, policy);
  const editor = await createMember(db, admin);
  const author = await createMember(db, admin);
  const reviewers = [];
  for (let i = 0; i < 3; i++) reviewers.push(await createMember(db, admin));
  return { editor, author, reviewers };
}

const kinds = async (operatorId: string) => (await listInbox(db, operatorId)).map((t) => t.kind);

async function expectCode(p: Promise<unknown>, code: DomainError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

describe("deadlines", () => {
  it("returns late reviews to the pool, where someone else takes them", async () => {
    const ctx = await setup({ review_deadline_hours: 72 });
    const { submissionId } = await submitManuscript(db, ctx.author, manuscript(), T0);
    await sendOut(db, ctx.editor, submissionId, T0);
    const late = await takeReview(db, ctx.reviewers[0]!,  submissionId, hours(1));

    expect(await processDeadlines(db, hours(72))).toMatchObject({ claimsExpired: 0 });
    // Due at 1h + 72h.
    expect(await processDeadlines(db, hours(74))).toMatchObject({ claimsExpired: 1 });
    const [a] = await db.select().from(reviewAssignments).where(eq(reviewAssignments.id, late));
    expect(a!.status).toBe("expired");
    expect(await kinds(ctx.reviewers[0]!.operatorId)).toEqual([]);
    await expectCode(submitReview(db, ctx.reviewers[0]!, late, review(), hours(74)), "INVALID_STATE");

    // Idempotent.
    expect(await processDeadlines(db, hours(75))).toEqual({ claimsExpired: 0, revisionsExpired: 0, published: 0 });

    // The slot is open again; the reviewer who let it expire doesn't get it back, another one does.
    const open = await db.select().from(poolTasks).where(and(eq(poolTasks.submissionId, submissionId), eq(poolTasks.status, "open")));
    expect(open.map((t) => t.kind)).toEqual(["review", "review"]);
    await takeReview(db, ctx.reviewers[1]!,  submissionId, hours(76));
    await takeReview(db, ctx.reviewers[2]!,  submissionId, hours(76));
  });

  it("returns late editorial tasks to the pool", async () => {
    const ctx = await setup({ editorial_deadline_hours: 24 });
    const { submissionId } = await submitManuscript(db, ctx.author, manuscript(), T0);
    await takeTask(db, ctx.editor, "editorial", submissionId, T0);
    expect((await processDeadlines(db, hours(25))).claimsExpired).toBe(1);
    const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(s!.handlingEditorId).toBeNull();
    expect(await kinds(ctx.editor.operatorId)).toEqual([]);
    // Another agent picks it up.
    await takeTask(db, ctx.reviewers[0]!,  "editorial", submissionId, hours(26));
  });

  it("refuses late reviews even before the tick runs", async () => {
    const ctx = await setup({ review_deadline_hours: 10 });
    const { submissionId } = await submitManuscript(db, ctx.author, manuscript(), T0);
    await sendOut(db, ctx.editor, submissionId, T0);
    const id = await takeReview(db, ctx.reviewers[0]!,  submissionId, T0);
    await expectCode(submitReview(db, ctx.reviewers[0]!, id, review(), hours(11)), "INVALID_STATE");
  });

  it("withdraws submissions whose revision deadline passed", async () => {
    const ctx = await setup({ revision_deadline_hours: 24 });
    const { submissionId } = await submitManuscript(db, ctx.author, manuscript(), T0);
    await sendOut(db, ctx.editor, submissionId, T0);
    for (const r of ctx.reviewers.slice(0, 2)) {
      await submitReview(db, r, await takeReview(db, r, submissionId, hours(1)), review(), hours(2));
    }
    await decide(db, ctx.editor, submissionId, "major_revision", hours(3));
    expect(await kinds(ctx.author.operatorId)).toEqual(["revise_submission"]);

    expect((await processDeadlines(db, hours(26))).revisionsExpired).toBe(0);
    expect((await processDeadlines(db, hours(28))).revisionsExpired).toBe(1);
    const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(s!.status).toBe("withdrawn");
    expect(await kinds(ctx.author.operatorId)).toEqual([]);
    await expectCode(
      submitRevision(db, ctx.author, submissionId, { ...manuscript(), responseToReviewersMd: "late" }, hours(29)),
      "INVALID_STATE",
    );
  });

  it("publishes accepted submissions left unpublished", async () => {
    const ctx = await setup({});
    const { submissionId } = await submitManuscript(db, ctx.author, manuscript(), T0);
    await adminOverride(db, admin, submissionId, "accepted", "Accepted outside the platform", T0);
    expect((await processDeadlines(db, hours(1))).published).toBe(1);
    const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(s!.status).toBe("published");
  });
});
