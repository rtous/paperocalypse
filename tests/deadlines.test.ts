import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { reviewAssignments, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { processDeadlines } from "@/lib/domain/deadlines";
import { DomainError } from "@/lib/domain/errors";
import type { JournalPolicy } from "@/lib/domain/policy";
import {
  inviteReviewers,
  makeDecision,
  respondToInvitation,
  submitManuscript,
  submitReview,
  submitRevision,
} from "@/lib/domain/submissions";
import { listOpenTasks } from "@/lib/domain/tasks";
import { createTestDb } from "./helpers/db";
import { LETTER, T0, createAdmin, createJournal, createMember, hours, manuscript, review } from "./helpers/fixtures";

// Each test gets its own database: deadline processing is global, so shared state would leak.
let db: Db;
let close: () => Promise<void>;
let admin: Actor & { type: "admin" };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
});
afterEach(async () => close());

async function setup(policy: Partial<JournalPolicy>) {
  const journal = await createJournal(db, policy);
  const editor = await createMember(db, admin, journal.id, ["editor"]);
  const author = await createMember(db, admin, journal.id, ["author"]);
  const reviewers = [];
  for (let i = 0; i < 3; i++) reviewers.push(await createMember(db, admin, journal.id, ["reviewer"]));
  return { journal, editor, author, reviewers };
}

const kinds = async (agentId: string) => (await listOpenTasks(db, agentId)).map((t) => t.kind);

async function expectCode(p: Promise<unknown>, code: DomainError["code"]) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
}

describe("deadlines", () => {
  it("expires invitations and late reviews, and asks the editor for replacements", async () => {
    const ctx = await setup({ invitation_response_hours: 48, review_deadline_hours: 72 });
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const { assignments } = await inviteReviewers(
      db,
      ctx.editor,
      submissionId,
      [ctx.reviewers[0]!.agentId, ctx.reviewers[1]!.agentId],
      T0,
    );
    await respondToInvitation(db, ctx.reviewers[1]!, assignments[1]!.assignmentId, true, null, hours(1));

    expect(await processDeadlines(db, hours(47))).toMatchObject({ invitationsExpired: 0, reviewsExpired: 0 });

    // Invitation 0 expires at 48h.
    expect(await processDeadlines(db, hours(49))).toMatchObject({ invitationsExpired: 1, reviewsExpired: 0 });
    expect(await kinds(ctx.reviewers[0]!.agentId)).toEqual([]);
    expect(await kinds(ctx.editor.agentId)).toEqual(["invite_replacement_reviewer"]);
    await expectCode(
      respondToInvitation(db, ctx.reviewers[0]!, assignments[0]!.assignmentId, true, null, hours(49)),
      "INVALID_STATE",
    );

    // Review 1 was due at 1h + 72h.
    expect(await processDeadlines(db, hours(74))).toMatchObject({ invitationsExpired: 0, reviewsExpired: 1 });
    const [a1] = await db.select().from(reviewAssignments).where(eq(reviewAssignments.id, assignments[1]!.assignmentId));
    expect(a1!.status).toBe("expired");
    await expectCode(submitReview(db, ctx.reviewers[1]!, assignments[1]!.assignmentId, review(), hours(74)), "INVALID_STATE");
    // Still one replacement task (deduplicated per submission).
    expect(await kinds(ctx.editor.agentId)).toEqual(["invite_replacement_reviewer"]);

    // Idempotent.
    expect(await processDeadlines(db, hours(75))).toEqual({
      invitationsExpired: 0,
      reviewsExpired: 0,
      revisionsExpired: 0,
      editorsAssigned: 0,
    });

    // Inviting a replacement closes the editor task.
    await inviteReviewers(db, ctx.editor, submissionId, [ctx.reviewers[2]!.agentId], hours(76));
    expect(await kinds(ctx.editor.agentId)).toEqual([]);
  });

  it("refuses late submissions even before the tick runs", async () => {
    const ctx = await setup({ review_deadline_hours: 10 });
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const { assignments } = await inviteReviewers(db, ctx.editor, submissionId, [ctx.reviewers[0]!.agentId], T0);
    await respondToInvitation(db, ctx.reviewers[0]!, assignments[0]!.assignmentId, true, null, T0);
    await expectCode(submitReview(db, ctx.reviewers[0]!, assignments[0]!.assignmentId, review(), hours(11)), "INVALID_STATE");
  });

  it("withdraws submissions whose revision deadline passed", async () => {
    const ctx = await setup({ revision_deadline_hours: 24 });
    const { submissionId } = await submitManuscript(db, ctx.author, ctx.journal.id, manuscript(), T0);
    const { assignments } = await inviteReviewers(
      db,
      ctx.editor,
      submissionId,
      [ctx.reviewers[0]!.agentId, ctx.reviewers[1]!.agentId],
      T0,
    );
    for (const [i, a] of assignments.entries()) {
      await respondToInvitation(db, ctx.reviewers[i]!, a.assignmentId, true, null, hours(1));
      await submitReview(db, ctx.reviewers[i]!, a.assignmentId, review(), hours(2));
    }
    await makeDecision(db, ctx.editor, submissionId, "major_revision", LETTER, hours(3));

    expect((await processDeadlines(db, hours(26))).revisionsExpired).toBe(0);
    expect((await processDeadlines(db, hours(28))).revisionsExpired).toBe(1);
    const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
    expect(s!.status).toBe("withdrawn");
    expect(await kinds(ctx.author.agentId)).toEqual([]);
    await expectCode(
      submitRevision(db, ctx.author, submissionId, { ...manuscript(), responseToReviewersMd: "late" }, hours(29)),
      "INVALID_STATE",
    );
  });
});
