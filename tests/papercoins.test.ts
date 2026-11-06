/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, papercoinTransactions, settings, submissions } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { createAgent, grantRoles } from "@/lib/domain/agents";
import { DomainError } from "@/lib/domain/errors";
import { adjustPapercoins, applyPapercoins, getPapercoinBalance } from "@/lib/domain/papercoins";
import {
  inviteReviewers,
  makeDecision,
  publishArticle,
  respondToInvitation,
  submitManuscript,
  submitReview,
} from "@/lib/domain/submissions";
import { clearSettingsCache } from "@/lib/mcp/framework";
import { createTestDb } from "./helpers/db";
import { LETTER, T0, createAdmin, createDashboardAgent, createJournal, createMember, hours, manuscript, review } from "./helpers/fixtures";
import { connect, fakeBlob, makeDeps, router } from "./helpers/mcp";

let db: Db;
let close: () => Promise<void>;
let admin: Actor & { type: "admin" };
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  admin = await createAdmin(db);
});
afterAll(async () => close());

const code = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof DomainError ? e.code : String(e)));

/** A journal member created without the fixture's generous balance. */
async function plainMember(journalId: string, roles: ("author" | "reviewer" | "editor")[], name: string) {
  const a = await createAgent(db, admin, { displayName: name, operatorContact: `${name}@coins.test` }, T0);
  await grantRoles(db, admin, journalId, a.id, roles, T0);
  return { type: "agent" as const, agentId: a.id };
}

async function ledgerIsConsistent(agentId: string) {
  const [sum] = await db
    .select({ s: sql<number>`coalesce(sum(${papercoinTransactions.amount}), 0)`.mapWith(Number) })
    .from(papercoinTransactions)
    .where(eq(papercoinTransactions.agentId, agentId));
  return (await getPapercoinBalance(db, agentId)) === sum!.s;
}

describe("papercoins", () => {
  it("new agents get the signup grant (configurable)", async () => {
    const a = await createAgent(db, admin, { displayName: "Newbie" }, T0);
    expect(await getPapercoinBalance(db, a.id)).toBe(3);
    const reg = await createDashboardAgent(db, "dash@coins.test", "Dashboard-created");
    expect(await getPapercoinBalance(db, reg.agentId)).toBe(3);

    await db.insert(settings).values({ key: "platform", value: { papercoin_signup_grant: 0 } });
    const b = await createAgent(db, admin, { displayName: "No grant" }, T0);
    expect(await getPapercoinBalance(db, b.id)).toBe(0);
    await db.delete(settings).where(eq(settings.key, "platform"));
  });

  it("charges submissions and publications, rewards reviews, and blocks authors in debt", async () => {
    const j = await createJournal(db, { max_submissions_per_agent_per_day: 50, max_open_submissions_per_agent: 50 });
    const editor = await createMember(db, admin, j.id, ["editor"]);
    const author = await plainMember(j.id, ["author", "reviewer"], "Author");
    const r1 = await plainMember(j.id, ["reviewer"], "R1");
    const r2 = await plainMember(j.id, ["reviewer"], "R2");

    // Submit (3 → 2). A failed submission (validation) charges nothing.
    expect(await code(submitManuscript(db, author, j.id, manuscript({ aiDisclosure: " " }), T0))).toBe("VALIDATION_ERROR");
    expect(await getPapercoinBalance(db, author.agentId)).toBe(3);
    const { submissionId } = await submitManuscript(db, author, j.id, manuscript(), T0);
    expect(await getPapercoinBalance(db, author.agentId)).toBe(2);

    // Two reviews: each reviewer earns 1; editing doesn't pay twice.
    const { assignments } = await inviteReviewers(db, editor, submissionId, [r1.agentId, r2.agentId], T0);
    for (const [i, r] of [r1, r2].entries()) {
      await respondToInvitation(db, r, assignments[i]!.assignmentId, true, null, T0);
      await submitReview(db, r, assignments[i]!.assignmentId, review(), T0);
    }
    await submitReview(db, r1, assignments[0]!.assignmentId, review({ summaryMd: "Edited summary." }), T0);
    expect(await getPapercoinBalance(db, r1.agentId)).toBe(4);
    expect(await getPapercoinBalance(db, r2.agentId)).toBe(4);

    // Two more submissions take the author to 0; the next is refused, nothing is created.
    await submitManuscript(db, author, j.id, manuscript(), hours(1));
    await submitManuscript(db, author, j.id, manuscript(), hours(2));
    expect(await getPapercoinBalance(db, author.agentId)).toBe(0);
    const before = (await db.select().from(submissions).where(eq(submissions.submittingAgentId, author.agentId))).length;
    const err = await submitManuscript(db, author, j.id, manuscript(), hours(3)).catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe("INSUFFICIENT_PAPERCOINS");
    expect(err.details).toMatchObject({ balance: 0, required: 1 });
    expect(err.message).toMatch(/review/i);
    expect((await db.select().from(submissions).where(eq(submissions.submittingAgentId, author.agentId))).length).toBe(before);

    // Publication charges 2 even at 0 (the editor is never blocked): balance goes to -2.
    await makeDecision(db, editor, submissionId, "accept", LETTER, hours(4));
    await publishArticle(db, editor, submissionId, hours(5));
    expect(await getPapercoinBalance(db, author.agentId)).toBe(-2);

    // Earning back by reviewing: three reviews → 1, enough to submit again.
    const other = await createMember(db, admin, j.id, ["author"]);
    for (let i = 0; i < 3; i++) {
      const s = await submitManuscript(db, other, j.id, manuscript(), hours(6 + i));
      const { assignments: as } = await inviteReviewers(db, editor, s.submissionId, [author.agentId], hours(6 + i));
      await respondToInvitation(db, author, as[0]!.assignmentId, true, null, hours(6 + i));
      await submitReview(db, author, as[0]!.assignmentId, review(), hours(6 + i));
    }
    expect(await getPapercoinBalance(db, author.agentId)).toBe(1);
    await submitManuscript(db, author, j.id, manuscript(), hours(10));
    expect(await getPapercoinBalance(db, author.agentId)).toBe(0);

    for (const a of [author, r1, r2]) expect(await ledgerIsConsistent(a.agentId)).toBe(true);
    const reasons = (await db.select().from(papercoinTransactions).where(eq(papercoinTransactions.agentId, author.agentId))).map((t) => t.reason);
    expect(reasons.filter((r) => r === "submission")).toHaveLength(4);
    expect(reasons.filter((r) => r === "publication")).toHaveLength(1);
    expect(reasons.filter((r) => r === "review")).toHaveLength(3);
  });

  it("applies a referenced entry only once", async () => {
    const a = await createAgent(db, admin, { displayName: "Once" }, T0);
    const ref = "00000000-0000-0000-0000-0000000000aa";
    await db.transaction((tx) => applyPapercoins(tx, { agentId: a.id, amount: 1, reason: "review", refId: ref, now: T0 }));
    await db.transaction((tx) => applyPapercoins(tx, { agentId: a.id, amount: 1, reason: "review", refId: ref, now: T0 }));
    expect(await getPapercoinBalance(db, a.id)).toBe(4);
  });

  it("admins can adjust balances; others cannot", async () => {
    const a = await createAgent(db, admin, { displayName: "Adjusted" }, T0);
    expect(await adjustPapercoins(db, admin, a.id, 10, "Pilot lab grant", T0)).toBe(13);
    expect(await adjustPapercoins(db, admin, a.id, -20, "Penalty for junk reviews", T0)).toBe(-7);
    expect(await code(adjustPapercoins(db, admin, a.id, 0, "nothing", T0))).toBe("VALIDATION_ERROR");
    expect(await code(adjustPapercoins(db, admin, a.id, 5, "", T0))).toBe("VALIDATION_ERROR");
    expect(await code(adjustPapercoins(db, { type: "agent", agentId: a.id }, a.id, 5, "self grant", T0))).toBe("NOT_AUTHORIZED");
    expect(await ledgerIsConsistent(a.id)).toBe(true);
    const [row] = await db.select().from(agents).where(eq(agents.id, a.id));
    expect(row!.papercoins).toBe(-7);
  });
});

describe("papercoins over MCP", () => {
  it("shows balances and history, and refuses submissions without coins", async () => {
    clearSettingsCache();
    const clock = { now: T0 };
    const handle = router(makeDeps(db, fakeBlob().gateway, clock));
    const j = await createJournal(db);
    await createMember(db, admin, j.id, ["editor"]);

    const reg = await createDashboardAgent(db, "coin@ops.test", "Coin Bot");
    const g = await connect(handle, "/api/mcp", reg.key);
    const c = await connect(handle, `/api/j/${j.slug}/mcp`, reg.key);
    await c.must("join_journal", { roles: ["author"] });
    expect((await c.must("get_my_tasks")).papercoins).toBe(3);

    const body = { title: "A paper about coins", abstract: "An abstract that is long enough to pass validation for sure.", keywords: ["coins"], body_md: "x ".repeat(200), ai_disclosure: "Written by a test script, no humans." };
    for (let i = 0; i < 3; i++) {
      clock.now = hours(i + 1);
      const s = await c.must("submit_manuscript", { ...body, idempotency_key: `coin-sub-${i}` });
      expect(s.papercoins).toBe(2 - i);
    }
    // Replaying an idempotent call does not charge again.
    await c.must("submit_manuscript", { ...body, idempotency_key: "coin-sub-2" });
    const broke = await c.call("submit_manuscript", { ...body, idempotency_key: "coin-sub-3" });
    expect(broke.code).toBe("INSUFFICIENT_PAPERCOINS");
    expect(broke.data.next_actions!.join(" ")).toMatch(/review/);
    expect((await c.must("get_my_tasks")).next_actions.join(" ")).toMatch(/review papers to earn/);

    const coins = await g.must("get_papercoins");
    expect(coins.balance).toBe(0);
    expect(coins.rules).toMatchObject({ submission_cost: 1, publication_cost: 2, review_reward: 1, signup_grant: 3 });
    expect(coins.transactions.map((t: any) => t.reason)).toEqual(["submission", "submission", "submission", "signup_grant"]);
    expect((await g.must("whoami")).papercoins).toBe(0);
    await g.close();
    await c.close();
  });
});
