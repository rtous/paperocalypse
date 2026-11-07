import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { operators } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { DomainError } from "@/lib/domain/errors";
import {
  operatorAuthorsSubmission,
  operatorEditorial,
  operatorPapercoinHistory,
  operatorReviews,
  operatorSubmissions,
  operatorTasks,
} from "@/lib/domain/operator-queries";
import {
  getOperator,
  operatorIssueKey,
  operatorRevokeKey,
  updateOperatorName,
  updateOperatorProfile,
  upsertOperatorFromLogin,
  verifyApiKey,
} from "@/lib/domain/operators";
import { adjustPapercoins, getPapercoinBalance } from "@/lib/domain/papercoins";
import { deskReject, submitManuscript, submitReview } from "@/lib/domain/submissions";
import { createTestDb, resetDb } from "./helpers/db";
import {
  LETTER,
  T0,
  createAdmin,
  setPolicy,
  createMember,
  createOperator,
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

const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof DomainError ? e.code : String(e)));

describe("operator accounts", () => {
  it("are created on first sign-in and refreshed on later ones", async () => {
    const op = await upsertOperatorFromLogin(db, { email: " Ada@Lab.org ", name: null, githubLogin: "ada" }, T0);
    expect(op).toMatchObject({ email: "ada@lab.org", name: "ada", githubLogin: "ada", status: "active" });
    // A later sign-in keeps the (possibly edited) name.
    await updateOperatorName(db, { type: "operator", operatorId: op!.id }, "Ada Lovelace", T0);
    const again = await upsertOperatorFromLogin(db, { email: "ada@lab.org", name: "ada-gh", githubLogin: "ada" }, hours(1));
    expect(again!.id).toBe(op!.id);
    expect(again!.name).toBe("Ada Lovelace");
    expect(await upsertOperatorFromLogin(db, { email: null, name: "x" }, T0)).toBeNull();
    // Suspended operators can't sign in.
    await db.update(operators).set({ status: "suspended" }).where(eq(operators.id, op!.id));
    expect(await upsertOperatorFromLogin(db, { email: "ada@lab.org", name: "x" }, T0)).toBeNull();
    expect(await code(updateOperatorName(db, { type: "operator", operatorId: op!.id }, "x", T0))).toBe("VALIDATION_ERROR");
  });

  it("get the welcome grant once and have one API key, which a new one replaces", async () => {
    const { operator, actor } = await createOperator(db, "grace@lab.org", "Grace");
    expect(operator.papercoins).toBe(3);
    expect(operator.apiKeyHash).toBeNull();
    await upsertOperatorFromLogin(db, { email: "grace@lab.org", name: "Grace" }, hours(1));
    expect(await getPapercoinBalance(db, operator.id)).toBe(3);

    const k1 = await operatorIssueKey(db, actor, T0);
    expect(await verifyApiKey(db, k1.apiKey, T0)).toEqual({ operatorId: operator.id });
    expect((await getOperator(db, operator.id))!.apiKeyPrefix).toBe(k1.keyPrefix);
    const k2 = await operatorIssueKey(db, actor, T0);
    expect(await verifyApiKey(db, k1.apiKey, T0)).toBeNull();
    expect(await verifyApiKey(db, k2.apiKey, T0)).toEqual({ operatorId: operator.id });
    await operatorRevokeKey(db, actor, T0);
    expect(await verifyApiKey(db, k2.apiKey, T0)).toBeNull();
    expect(await code(operatorRevokeKey(db, actor, T0))).toBe("NOT_FOUND");
  });

  it("set reviewer topics and a webhook (with a new secret, once)", async () => {
    const { operator, actor } = await createOperator(db, "topics@lab.org");
    const r = await updateOperatorProfile(db, actor, { reviewerTopics: [" Physics", "physics", "Biology "], webhookUrl: "https://hooks.example.org/x" }, T0);
    expect(r.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    const op = (await getOperator(db, operator.id))!;
    expect(op.reviewerTopics).toEqual(["physics", "biology"]);
    expect(op.webhookUrl).toBe("https://hooks.example.org/x");
    expect((await updateOperatorProfile(db, actor, { webhookUrl: "https://hooks.example.org/x" }, T0)).webhookSecret).toBeNull();
    expect(await code(updateOperatorProfile(db, actor, { webhookUrl: "https://169.254.169.254/x" }, T0))).toBe("VALIDATION_ERROR");
  });

  it("can't act on submissions they have nothing to do with", async () => {
    await setPolicy(db);
    const author = await createMember(db, admin);
    const { submissionId } = await submitManuscript(db, author, manuscript(), T0);
    const { actor } = await createOperator(db, "meddler@lab.org");
    expect(await code(deskReject(db, actor, submissionId, LETTER, T0))).toBe("NOT_FOUND");
  });
});

describe("operator dashboard data", () => {
  it("shows the operator's tasks, submissions, reviews, editorial work and coins only", async () => {
    // The task pool is platform-wide: start from an empty platform.
    await resetDb(db);
    admin = await createAdmin(db);
    await setPolicy(db, { max_submissions_per_operator_per_day: 50, max_open_submissions_per_operator: 50 });
    const mk = async (email: string, name: string) => {
      const { actor } = await createOperator(db, email, name);
      await adjustPapercoins(db, admin, actor.operatorId, 50, "test", T0);
      return actor;
    };
    const me = await mk("me@dash.org", "Me");
    const them = await mk("them@dash.org", "Them");
    const neutral = await mk("neutral@dash.org", "Neutral");
    const other = await mk("other@dash.org", "Other");

    // I screen their paper; the neutral operator screens mine and their second one.
    const theirSub = await submitManuscript(db, them, manuscript({ title: "Their paper" }), T0);
    const mySub = await submitManuscript(db, me, manuscript({ title: "My paper" }), hours(0.5));
    const theirB = await submitManuscript(db, them, manuscript({ title: "Their B" }), hours(0.7));
    await sendOut(db, me, theirSub.submissionId, hours(1));
    await sendOut(db, neutral, mySub.submissionId, hours(1.1));
    await sendOut(db, neutral, theirB.submissionId, hours(1.2));
    // I can't review my paper (conflict) or their paper (I screened it): I get B.
    const myAssignment = await takeReview(db, me, theirB.submissionId, hours(2));

    expect((await operatorTasks(db, me.operatorId)).map((t) => t.kind)).toEqual(["write_review"]);
    expect((await operatorSubmissions(db, me.operatorId)).map((s) => s.title)).toEqual(["My paper"]);
    expect(await operatorAuthorsSubmission(db, me.operatorId, mySub.submissionId)).toBe(true);
    expect(await operatorAuthorsSubmission(db, me.operatorId, theirSub.submissionId)).toBe(false);
    expect((await operatorReviews(db, me.operatorId)).map((r) => [r.submissionTitle, r.status])).toEqual([["Their B", "accepted"]]);
    expect((await operatorEditorial(db, me.operatorId)).map((e) => [e.title, e.taskStatus])).toEqual([["Their paper", "done"]]);
    expect((await operatorEditorial(db, neutral.operatorId)).map((e) => e.title).sort()).toEqual(["My paper", "Their B"]);
    expect(await operatorEditorial(db, them.operatorId)).toEqual([]);

    // Each completed review and editorial task pays 1 papercoin.
    const before = await getPapercoinBalance(db, me.operatorId);
    await submitReview(db, me, myAssignment, review(), hours(3));
    const theirSub2 = await submitManuscript(db, them, manuscript({ title: "Their second paper" }), hours(3));
    await takeTask(db, me, "editorial", theirSub2.submissionId, hours(3));
    await deskReject(db, me, theirSub2.submissionId, LETTER, hours(3));
    expect(await getPapercoinBalance(db, me.operatorId)).toBe(before + 2);
    for (const r of [neutral, other]) {
      await submitReview(db, r, await takeReview(db, r, theirSub.submissionId, hours(4)), review(), hours(4));
    }
    // The neutral and other operators reviewed it, so the decision comes to me.
    await decide(db, me, theirSub.submissionId, "major_revision", hours(5));
    expect(await getPapercoinBalance(db, me.operatorId)).toBe(before + 3);
    // Admin decisions pay nobody.
    const theirSub3 = await submitManuscript(db, them, manuscript({ title: "Third" }), hours(6));
    await deskReject(db, admin, theirSub3.submissionId, LETTER, hours(6));
    expect(await getPapercoinBalance(db, me.operatorId)).toBe(before + 3);

    const history = await operatorPapercoinHistory(db, me.operatorId);
    // Screening their paper, desk-rejecting the second one, and the decision.
    expect(history.filter((h) => h.reason === "editorial_decision")).toHaveLength(3);
    expect(history.filter((h) => h.reason === "review")).toHaveLength(1);
  });
});
