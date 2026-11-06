import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, operators } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { grantRoles, verifyApiKey } from "@/lib/domain/agents";
import { DomainError } from "@/lib/domain/errors";
import {
  operatorAgents,
  operatorAuthorsSubmission,
  operatorEditorial,
  operatorPapercoinHistory,
  operatorReviews,
  operatorSubmissions,
  operatorTasks,
} from "@/lib/domain/operator-queries";
import {
  createOperatorAgent,
  operatorIssueKey,
  operatorRevokeKey,
  requireOwnAgent,
  updateOperatorName,
  upsertOperatorFromLogin,
} from "@/lib/domain/operators";
import { adjustPapercoins, getPapercoinBalance, walletInfo } from "@/lib/domain/papercoins";
import {
  deskReject,
  submitManuscript,
  submitReview,
} from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import {
  LETTER,
  T0,
  createAdmin,
  createJournal,
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
  });

  it("create agents linked to themselves, with a working key, sharing one wallet granted once", async () => {
    const { operator, actor } = await createOperator(db, "grace@lab.org", "Grace");
    expect(operator.papercoins).toBe(3);
    const r = await createOperatorAgent(db, actor, { displayName: "Grace-Bot", description: "Claude via Claude Code" }, T0);
    expect(r.agent).toMatchObject({ operatorId: operator.id, operatorName: "Grace", operatorContact: "grace@lab.org" });
    expect((await verifyApiKey(db, r.apiKey, T0))?.agentId).toBe(r.agent.id);
    expect(await getPapercoinBalance(db, r.agent.id)).toBe(3);
    // More agents (and more sign-ins) don't bring more welcome grants.
    const r2 = await createOperatorAgent(db, actor, { displayName: "Grace-Bot-2", description: "" }, T0);
    await upsertOperatorFromLogin(db, { email: "grace@lab.org", name: "Grace" }, hours(1));
    expect(await getPapercoinBalance(db, r2.agent.id)).toBe(3);
    expect((await walletInfo(db, r2.agent.id)).operatorName).toBe("Grace");
    expect(await code(createOperatorAgent(db, actor, { displayName: "x", description: "" }, T0))).toBe("VALIDATION_ERROR");
  });

  it("manage only their own agents' keys", async () => {
    const a = await createOperator(db, "a@lab.org");
    const b = await createOperator(db, "b@lab.org");
    const agentA = await createOperatorAgent(db, a.actor, { displayName: "A-Bot", description: "" }, T0);
    expect(await code(requireOwnAgent(db, b.actor, agentA.agent.id))).toBe("NOT_FOUND");
    expect(await code(operatorIssueKey(db, b.actor, agentA.agent.id, "steal", T0))).toBe("NOT_FOUND");
    const k = await operatorIssueKey(db, a.actor, agentA.agent.id, "second", T0);
    expect(await code(operatorRevokeKey(db, b.actor, k.keyId, T0))).toBe("NOT_FOUND");
    await operatorRevokeKey(db, a.actor, k.keyId, T0);
    expect(await verifyApiKey(db, k.apiKey, T0)).toBeNull();
    expect((await verifyApiKey(db, agentA.apiKey, T0))?.agentId).toBe(agentA.agent.id);
  });

  it("can't act on submissions directly", async () => {
    const j = await createJournal(db);
    await createMember(db, admin, j.id, ["reviewer"]);
    const author = await createMember(db, admin, j.id, ["author"]);
    const { submissionId } = await submitManuscript(db, author, j.id, manuscript(), T0);
    const { actor } = await createOperator(db, "meddler@lab.org");
    expect(await code(deskReject(db, actor, submissionId, LETTER, T0))).toBe("NOT_AUTHORIZED");
  });

  it("renaming updates the public name everywhere, including rankings", async () => {
    const { actor } = await createOperator(db, "rename@lab.org", "Old Name");
    const r = await createOperatorAgent(db, actor, { displayName: "Rename-Bot", description: "" }, T0);
    await updateOperatorName(db, actor, "New Name", T0);
    const [a] = await db.select().from(agents).where(eq(agents.id, r.agent.id));
    expect(a!.operatorName).toBe("New Name");
    expect(await code(updateOperatorName(db, actor, "x", T0))).toBe("VALIDATION_ERROR");
  });

});

describe("operator dashboard data", () => {
  it("shows tasks, submissions, reviews, editorial work and coins of the operator's agents only", async () => {
    const j = await createJournal(db, { max_submissions_per_agent_per_day: 50, max_open_submissions_per_agent: 50 });
    const J = j.id;
    const mine = await createOperator(db, "me@dash.org", "Me");
    const theirs = await createOperator(db, "them@dash.org", "Them");
    const neutral = await createOperator(db, "neutral@dash.org", "Neutral");
    const other = await createOperator(db, "other@dash.org", "Other");
    const mk = async (o: typeof mine, name: string, roles: ("author" | "reviewer")[]) => {
      const r = await createOperatorAgent(db, o.actor, { displayName: name, description: "" }, T0);
      await grantRoles(db, admin, J, r.agent.id, roles, T0);
      await adjustPapercoins(db, admin, r.agent.operatorId, 50, "test", T0);
      return { type: "agent" as const, agentId: r.agent.id };
    };
    const myEditor = await mk(mine, "My-Editor", ["reviewer"]);
    const neutralEditor = await mk(neutral, "Neutral-Editor", ["reviewer"]);
    const myAuthor = await mk(mine, "My-Author", ["author"]);
    const myReviewer = await mk(mine, "My-Reviewer", ["reviewer"]);
    const neutralReviewer = await mk(neutral, "Neutral-Reviewer", ["reviewer"]);
    const otherReviewer = await mk(other, "Other-Reviewer", ["reviewer"]);
    const theirAuthor = await mk(theirs, "Their-Author", ["author"]);

    // My editor screens their paper; the neutral editor screens mine and their second one.
    const theirSub = await submitManuscript(db, theirAuthor, J, manuscript({ title: "Their paper" }), T0);
    const mySub = await submitManuscript(db, myAuthor, J, manuscript({ title: "My paper" }), hours(0.5));
    const theirB = await submitManuscript(db, theirAuthor, J, manuscript({ title: "Their B" }), hours(0.7));
    await sendOut(db, myEditor, J, theirSub.submissionId, hours(1));
    await sendOut(db, neutralEditor, J, mySub.submissionId, hours(1.1));
    await sendOut(db, neutralEditor, J, theirB.submissionId, hours(1.2));
    // My reviewer can't review my paper (conflict) or their paper (my editor screened it): it gets B.
    const myAssignment = await takeReview(db, myReviewer, J, theirB.submissionId, hours(2));

    const tasks = await operatorTasks(db, mine.operator.id);
    expect(tasks.map((t) => [t.agentName, t.kind])).toEqual([["My-Reviewer", "write_review"]]);
    expect(JSON.stringify(tasks)).not.toContain("Neutral-");

    expect((await operatorSubmissions(db, mine.operator.id)).map((s) => s.title)).toEqual(["My paper"]);
    expect(await operatorAuthorsSubmission(db, mine.operator.id, mySub.submissionId)).toBe(true);
    expect(await operatorAuthorsSubmission(db, mine.operator.id, theirSub.submissionId)).toBe(false);

    const myReviews = await operatorReviews(db, mine.operator.id);
    expect(myReviews.map((r) => [r.agentName, r.submissionTitle, r.status])).toEqual([["My-Reviewer", "Their B", "accepted"]]);

    expect((await operatorEditorial(db, mine.operator.id)).map((e) => [e.title, e.taskStatus])).toEqual([["Their paper", "done"]]);
    expect((await operatorEditorial(db, neutral.operator.id)).map((e) => e.title).sort()).toEqual(["My paper", "Their B"]);
    expect(await operatorEditorial(db, theirs.operator.id)).toEqual([]);

    const agentsList = await operatorAgents(db, mine.operator.id);
    expect(agentsList.map((a) => a.displayName)).toEqual(["My-Author", "My-Editor", "My-Reviewer"]);
    expect(agentsList.find((a) => a.displayName === "My-Reviewer")!.openTasks).toBe(1);

    // Each editorial task pays the editor 1 papercoin; reviews pay 1. All go to my shared wallet.
    const before = await getPapercoinBalance(db, myEditor.agentId);
    const theirSub2 = await submitManuscript(db, theirAuthor, J, manuscript({ title: "Their second paper" }), hours(3));
    await takeTask(db, myEditor, J, "editorial", theirSub2.submissionId, hours(3));
    await deskReject(db, myEditor, theirSub2.submissionId, LETTER, hours(3));
    expect(await getPapercoinBalance(db, myEditor.agentId)).toBe(before + 1);
    await submitReview(db, myReviewer, myAssignment, review(), hours(4));
    for (const r of [neutralReviewer, otherReviewer]) {
      await submitReview(db, r, await takeReview(db, r, J, theirSub.submissionId, hours(4)), review(), hours(4));
    }
    // The neutral and other operators reviewed it, so the decision goes to my editor.
    await decide(db, myEditor, J, theirSub.submissionId, "major_revision", hours(5));
    expect(await getPapercoinBalance(db, myEditor.agentId)).toBe(before + 3);
    expect(await getPapercoinBalance(db, myReviewer.agentId)).toBe(before + 3);
    // Admin decisions pay nobody.
    const theirSub3 = await submitManuscript(db, theirAuthor, J, manuscript({ title: "Third" }), hours(6));
    await deskReject(db, admin, theirSub3.submissionId, LETTER, hours(6));
    expect(await getPapercoinBalance(db, myEditor.agentId)).toBe(before + 3);

    const history = await operatorPapercoinHistory(db, mine.operator.id);
    expect(history.filter((h) => h.reason === "editorial_decision")).toHaveLength(3);
    expect(history.filter((h) => h.reason === "review")).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain("Neutral-");
  });
});
