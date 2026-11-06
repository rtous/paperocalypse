import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, articleCitations, journals } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { createAgent, grantRoles } from "@/lib/domain/agents";
import { citationCount, extractCitationRefs } from "@/lib/domain/citations";
import { contributorRanking } from "@/lib/domain/rankings";
import {
  inviteReviewers,
  makeDecision,
  publishArticle,
  respondToInvitation,
  submitManuscript,
  submitReview,
} from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import { LETTER, T0, createAdmin, createJournal, hours, manuscript, review } from "./helpers/fixtures";

describe("extractCitationRefs", () => {
  it("finds permanent ids and article URLs, deduplicated", () => {
    const refs = extractCitationRefs(
      "See paperocalypse:demo.2026.3 and [this](https://paperocalypse.vercel.app/j/demo/articles/3), " +
        "also paperocalypse:demo.2026.3 again, /j/other-journal/articles/12 and (paperocalypse:x1.2027.1).",
    );
    expect(refs).toEqual([
      { publicId: "paperocalypse:demo.2026.3" },
      { publicId: "paperocalypse:x1.2027.1" },
      { slug: "demo", articleNo: 3 },
      { slug: "other-journal", articleNo: 12 },
    ]);
  });

  it("ignores look-alikes", () => {
    expect(extractCitationRefs("paperocalypse:Demo.2026.1 /j/demo/articles/ /j/demo/article/3 paperocalypse:demo.26.1")).toEqual([]);
  });
});

describe("contributor rankings", () => {
  let db: Db;
  let close: () => Promise<void>;
  let admin: Actor & { type: "admin" };
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    admin = await createAdmin(db);
  });
  afterAll(async () => close());

  async function agent(journalId: string, name: string, roles: ("author" | "reviewer" | "editor")[], operator?: { name?: string; contact: string }) {
    const a = await createAgent(db, admin, { displayName: name, operatorName: operator?.name ?? null, operatorContact: operator?.contact ?? null }, T0);
    await grantRoles(db, admin, journalId, a.id, roles, T0);
    return { type: "agent" as const, agentId: a.id };
  }

  async function setupJournal() {
    const j = await createJournal(db, { require_operator_contact: false, max_submissions_per_agent_per_day: 50, max_open_submissions_per_agent: 50 });
    const editor = await agent(j.id, `Editor-${j.slug}`, ["editor"], { contact: `ed-${j.slug}@x.org` });
    const r1 = await agent(j.id, `R1-${j.slug}`, ["reviewer"], { contact: `r1-${j.slug}@x.org` });
    const r2 = await agent(j.id, `R2-${j.slug}`, ["reviewer"], { contact: `r2-${j.slug}@x.org` });
    return { j, editor, r1, r2 };
  }

  let clock = T0;
  async function publish(ctx: Awaited<ReturnType<typeof setupJournal>>, author: Actor & { type: "agent" }, body: string, coAuthorAgentIds: string[] = []) {
    clock = hours(1, clock);
    const { submissionId } = await submitManuscript(db, author, ctx.j.id, manuscript({ bodyMd: body, coAuthorAgentIds }), clock);
    const { assignments } = await inviteReviewers(db, ctx.editor, submissionId, [ctx.r1.agentId, ctx.r2.agentId], clock);
    for (const [i, r] of [ctx.r1, ctx.r2].entries()) {
      await respondToInvitation(db, r, assignments[i]!.assignmentId, true, null, clock);
      await submitReview(db, r, assignments[i]!.assignmentId, review(), clock);
    }
    await makeDecision(db, ctx.editor, submissionId, "accept", LETTER, clock);
    return publishArticle(db, ctx.editor, submissionId, clock);
  }

  it("counts papers and internal citations per operator, across agents and journals", async () => {
    const A = await setupJournal();
    const B = await setupJournal();
    // Alice runs two agents; Bob one; one agent has no operator at all.
    const alice1 = await agent(A.j.id, "Alice-Bot-1", ["author"], { name: "Alice", contact: "alice@lab.org" });
    const alice2 = await agent(A.j.id, "Alice-Bot-2", ["author"], { name: "Alice Smith", contact: " ALICE@lab.org " });
    // Alice renamed herself later: the most recent operator_name wins.
    await db.update(agents).set({ updatedAt: hours(1) }).where(eq(agents.id, alice2.agentId));
    const bob = await agent(A.j.id, "Bob-Bot", ["author"], { name: "Bob", contact: "bob@lab.org" });
    const anon = await agent(A.j.id, "Orphan-Bot", ["author"]);
    const unnamed = await agent(B.j.id, "Quiet-Bot", ["author"], { contact: "quiet@lab.org" });
    await grantRoles(db, admin, B.j.id, bob.agentId, ["author"], T0);

    const a1 = await publish(A, alice1, "First paper by Alice. ".repeat(20));
    const a2 = await publish(A, alice2, "Second Alice paper. ".repeat(20));
    // Bob cites both Alice papers (by id and by URL) and co-authors with Orphan-Bot.
    const b1 = await publish(A, bob, `We build on ${a1.publicId} and https://example.org/j/${A.j.slug}/articles/${a2.articleNo}. `.repeat(5), [anon.agentId]);
    // In journal B: Bob cites a1 again and his own b1; Quiet cites a1.
    await publish(B, bob, `See ${a1.publicId} and ${b1.publicId}. `.repeat(10));
    await publish(B, unnamed, `Building on ${a1.publicId}, and citing a missing paperocalypse:nope.2026.99. `.repeat(5));

    expect(await citationCount(db, a1.articleId)).toBe(3);
    expect(await citationCount(db, a2.articleId)).toBe(1);
    expect(await citationCount(db, b1.articleId)).toBe(1);

    // Global, by papers: Alice 2 papers / 4 citations; Bob 2 papers / 1 citation; unnamed operator 1 / 0.
    const byPapers = await contributorRanking(db, { sort: "papers" });
    const mine = byPapers.filter((r) => ["Alice Smith", "Alice", "Bob", "Unnamed operator"].includes(r.name));
    expect(mine.map((r) => [r.name, r.papers, r.citations])).toEqual([
      ["Alice Smith", 2, 4],
      ["Bob", 2, 1],
      ["Unnamed operator", 1, 0],
    ]);
    // Ties share a rank.
    expect(mine[0]!.rank).toBe(mine[1]!.rank);
    expect(mine[0]!.agents).toEqual(["Alice-Bot-1", "Alice-Bot-2"]);
    // The orphan agent (no operator) is never ranked; operator contacts never leak.
    expect(JSON.stringify(byPapers)).not.toContain("Orphan-Bot");
    expect(JSON.stringify(byPapers)).not.toContain("@lab.org");

    // By citations.
    const byCitations = await contributorRanking(db, { sort: "citations" });
    expect(byCitations[0]).toMatchObject({ rank: 1, name: "Alice Smith", citations: 4 });

    // Journal B only: Bob 1 paper, Quiet 1 paper; citations count what B's papers received (none).
    const inB = await contributorRanking(db, { journalId: B.j.id, sort: "papers" });
    expect(inB.map((r) => [r.name, r.papers, r.citations]).sort()).toEqual([
      ["Bob", 1, 0],
      ["Unnamed operator", 1, 0],
    ]);

    // Archived journals drop out of the global ranking.
    await db.update(journals).set({ status: "archived" }).where(eq(journals.id, B.j.id));
    const after = await contributorRanking(db, { sort: "papers" });
    expect(after.find((r) => r.name === "Unnamed operator")).toBeUndefined();
    expect(after.find((r) => r.name === "Bob")!.papers).toBe(1);

    // Citations are idempotent per (citing, cited) pair.
    const rows = await db.select().from(articleCitations).where(eq(articleCitations.citedArticleId, a1.articleId));
    expect(rows).toHaveLength(3);
  });
});
