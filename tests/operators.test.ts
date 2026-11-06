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
  linkAgentToOperator,
  operatorIssueKey,
  operatorRevokeKey,
  requireOwnAgent,
  updateOperatorName,
  upsertOperatorFromLogin,
} from "@/lib/domain/operators";
import { adjustPapercoins, getPapercoinBalance, walletInfo } from "@/lib/domain/papercoins";
import {
  deskReject,
  inviteReviewers,
  makeDecision,
  respondToInvitation,
  submitManuscript,
  submitReview,
} from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import { LETTER, T0, createAdmin, createJournal, createMember, createOperator, hours, manuscript, review } from "./helpers/fixtures";

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
    expect(r.agent).toMatchObject({ operatorId: operator.id, operatorName: "Grace", operatorContact: "grace@lab.org", papercoins: 0 });
    expect((await verifyApiKey(db, r.apiKey, T0))?.agentId).toBe(r.agent.id);
    expect(await getPapercoinBalance(db, r.agent.id)).toBe(3);
    // More agents (and more sign-ins) don't bring more welcome grants.
    const r2 = await createOperatorAgent(db, actor, { displayName: "Grace-Bot-2", description: "" }, T0);
    await upsertOperatorFromLogin(db, { email: "grace@lab.org", name: "Grace" }, hours(1));
    expect(await getPapercoinBalance(db, r2.agent.id)).toBe(3);
    expect((await walletInfo(db, r2.agent.id)).owner).toBe("operator");
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
    await createMember(db, admin, j.id, ["editor"]);
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

  it("admins can link legacy agents to an operator", async () => {
    const j = await createJournal(db);
    const legacy = await createMember(db, admin, j.id, ["author"]);
    await createOperator(db, "heir@lab.org", "Heir");
    // The legacy agent had its own wallet (fixture: 3 + 500); linking moves it to the operator's (3).
    expect(await walletInfo(db, legacy.agentId)).toMatchObject({ owner: "agent", balance: 503 });
    await linkAgentToOperator(db, admin, legacy.agentId, "HEIR@lab.org", T0);
    expect(await walletInfo(db, legacy.agentId)).toMatchObject({ owner: "operator", balance: 506 });
    const [a] = await db.select().from(agents).where(eq(agents.id, legacy.agentId));
    expect(a).toMatchObject({ operatorName: "Heir", operatorContact: "heir@lab.org", operatorContactNormalized: "heir@lab.org" });
    expect(await code(linkAgentToOperator(db, admin, legacy.agentId, "nobody@lab.org", T0))).toBe("VALIDATION_ERROR");
    expect(await code(linkAgentToOperator(db, legacy, legacy.agentId, "heir@lab.org", T0))).toBe("NOT_AUTHORIZED");
  });
});

describe("operator dashboard data", () => {
  it("shows tasks, submissions, reviews, editorial work and coins of the operator's agents only", async () => {
    const j = await createJournal(db, { max_submissions_per_agent_per_day: 50, max_open_submissions_per_agent: 50 });
    const mine = await createOperator(db, "me@dash.org", "Me");
    const theirs = await createOperator(db, "them@dash.org", "Them");
    const mk = async (o: typeof mine, name: string, roles: ("author" | "reviewer" | "editor")[]) => {
      const r = await createOperatorAgent(db, o.actor, { displayName: name, description: "" }, T0);
      await grantRoles(db, admin, j.id, r.agent.id, roles, T0);
      await adjustPapercoins(db, admin, r.agent.id, 50, "test", T0);
      return { type: "agent" as const, agentId: r.agent.id };
    };
    const neutral = await createOperator(db, "neutral@dash.org", "Neutral");
    // Editors are never assigned to their own operator's papers, so a neutral editor exists too.
    const myEditor = await mk(mine, "My-Editor", ["editor"]);
    await mk(neutral, "Neutral-Editor", ["editor"]);
    const myAuthor = await mk(mine, "My-Author", ["author"]);
    const myReviewer = await mk(mine, "My-Reviewer", ["reviewer"]);
    const neutralReviewer = await mk(neutral, "Neutral-Reviewer", ["reviewer"]);
    const theirAuthor = await mk(theirs, "Their-Author", ["author"]);

    // Their paper goes to my editor (first in rotation); mine goes to the neutral editor.
    const theirSub = await submitManuscript(db, theirAuthor, j.id, manuscript({ title: "Their paper" }), T0);
    const mySub = await submitManuscript(db, myAuthor, j.id, manuscript({ title: "My paper" }), T0);
    const { assignments } = await inviteReviewers(db, myEditor, theirSub.submissionId, [myReviewer.agentId, neutralReviewer.agentId], hours(1));
    await respondToInvitation(db, myReviewer, assignments[0]!.assignmentId, true, null, hours(2));

    const tasks = await operatorTasks(db, mine.operator.id);
    expect(tasks.map((t) => [t.agentName, t.kind])).toEqual([["My-Reviewer", "write_review"]]);
    expect(JSON.stringify(tasks)).not.toContain("Neutral-");

    expect((await operatorSubmissions(db, mine.operator.id)).map((s) => s.title)).toEqual(["My paper"]);
    expect(await operatorAuthorsSubmission(db, mine.operator.id, mySub.submissionId)).toBe(true);
    expect(await operatorAuthorsSubmission(db, mine.operator.id, theirSub.submissionId)).toBe(false);

    const myReviews = await operatorReviews(db, mine.operator.id);
    expect(myReviews.map((r) => [r.agentName, r.submissionTitle, r.status])).toEqual([["My-Reviewer", "Their paper", "accepted"]]);

    expect((await operatorEditorial(db, mine.operator.id)).map((e) => e.title)).toEqual(["Their paper"]);
    expect((await operatorEditorial(db, neutral.operator.id)).map((e) => e.title)).toEqual(["My paper"]);
    expect(await operatorEditorial(db, theirs.operator.id)).toEqual([]);

    const agentsList = await operatorAgents(db, mine.operator.id);
    expect(agentsList.map((a) => a.displayName)).toEqual(["My-Author", "My-Editor", "My-Reviewer"]);
    expect(agentsList.find((a) => a.displayName === "My-Reviewer")!.openTasks).toBe(1);

    // Editorial decisions pay the editor 1 papercoin each.
    const before = await getPapercoinBalance(db, myEditor.agentId);
    const theirSub2 = await submitManuscript(db, theirAuthor, j.id, manuscript({ title: "Their second paper" }), hours(3));
    await deskReject(db, myEditor, theirSub2.submissionId, LETTER, hours(3));
    expect(await getPapercoinBalance(db, myEditor.agentId)).toBe(before + 1);
    await submitReview(db, myReviewer, assignments[0]!.assignmentId, review(), hours(4));
    await respondToInvitation(db, neutralReviewer, assignments[1]!.assignmentId, true, null, hours(4));
    await submitReview(db, neutralReviewer, assignments[1]!.assignmentId, review(), hours(4));
    await makeDecision(db, myEditor, theirSub.submissionId, "major_revision", LETTER, hours(5));
    // My reviewer's review and my editor's two decisions all land in my (shared) wallet.
    expect(await getPapercoinBalance(db, myEditor.agentId)).toBe(before + 3);
    expect(await getPapercoinBalance(db, myReviewer.agentId)).toBe(before + 3);
    // Admin decisions pay nobody.
    const theirSub3 = await submitManuscript(db, theirAuthor, j.id, manuscript({ title: "Third" }), hours(6));
    await deskReject(db, admin, theirSub3.submissionId, LETTER, hours(6));
    expect(await getPapercoinBalance(db, myEditor.agentId)).toBe(before + 3);

    const history = await operatorPapercoinHistory(db, mine.operator.id);
    expect(history.filter((h) => h.reason === "editorial_decision")).toHaveLength(2);
    expect(history.filter((h) => h.reason === "review")).toHaveLength(1);
    expect(JSON.stringify(history)).not.toContain("Neutral-");
  });
});
