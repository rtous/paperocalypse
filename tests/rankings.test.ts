import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { articleCitations } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { updateOperatorName } from "@/lib/domain/operators";
import { citationStats, extractCitationRefs } from "@/lib/domain/citations";
import { adjustPapercoins } from "@/lib/domain/papercoins";
import { contributorRanking } from "@/lib/domain/rankings";
import { submitManuscript, submitReview } from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import { T0, agentFor, createAdmin, setPolicy, decide, hours, manuscript, review, sendOut, takeReview } from "./helpers/fixtures";

describe("extractCitationRefs", () => {
  it("finds permanent ids and article URLs, deduplicated", () => {
    const refs = extractCitationRefs(
      "See paperocalypse:2026.3 and [this](https://paperocalypse.vercel.app/articles/3), " +
        "also paperocalypse:2026.3 again, http://localhost.paperocalypse.dev/articles/12 and (paperocalypse:2027.1).",
    );
    expect(refs).toEqual([{ publicId: "paperocalypse:2026.3" }, { publicId: "paperocalypse:2027.1" }, { articleNo: 3 }, { articleNo: 12 }]);
  });

  it("ignores look-alikes and other sites", () => {
    expect(
      extractCitationRefs("paperocalypse:26.1 paperocalypse:x.2026.1 https://www.nature.com/articles/12 https://paperocalypse.vercel.app/articles/ /articles/3"),
    ).toEqual([]);
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

  async function agent(name: string, operator?: { name?: string; contact: string }) {
    const a = await agentFor(db, admin, name, { email: operator?.contact, operatorName: operator?.name });
    await adjustPapercoins(db, admin, a.operatorId, 100, "test balance", T0);
    return { type: "agent" as const, agentId: a.id, operatorId: a.operatorId };
  }

  async function setupTeam(t: string) {
    await setPolicy(db, { max_submissions_per_agent_per_day: 50, max_open_submissions_per_agent: 50 });
    const editor = await agent(`Editor-${t}`, { contact: `ed-${t}@x.org` });
    const r1 = await agent(`R1-${t}`, { contact: `r1-${t}@x.org` });
    const r2 = await agent(`R2-${t}`, { contact: `r2-${t}@x.org` });
    return { editor, r1, r2 };
  }

  let clock = T0;
  async function publish(ctx: Awaited<ReturnType<typeof setupTeam>>, author: Actor & { type: "agent" }, body: string, coAuthorAgentIds: string[] = []) {
    clock = hours(1, clock);
    const { submissionId } = await submitManuscript(db, author, manuscript({ bodyMd: body, coAuthorAgentIds }), clock);
    await sendOut(db, ctx.editor, submissionId, clock);
    for (const r of [ctx.r1, ctx.r2]) await submitReview(db, r, await takeReview(db, r, submissionId, clock), review(), clock);
    return (await decide(db, ctx.editor, submissionId, "accept", clock)).article!;
  }

  it("counts papers and internal citations per operator, across agents", async () => {
    // Two editorial teams, so that editors and reviewers vary between papers.
    const A = await setupTeam("a");
    const B = await setupTeam("b");
    // Alice runs two agents; Bob, Charlie and Quinn one each.
    const alice1 = await agent("Alice-Bot-1", { name: "Alice", contact: "alice@lab.org" });
    const alice2 = await agent("Alice-Bot-2", { contact: " ALICE@lab.org " });
    // Alice renames herself: the ranking shows the operator's current name.
    await updateOperatorName(db, { type: "operator", operatorId: alice1.operatorId }, "Alice Smith", hours(1));
    const bob = await agent("Bob-Bot", { name: "Bob", contact: "bob@lab.org" });
    const charlie = await agent("Charlie-Bot", { name: "Charlie", contact: "charlie@lab.org" });
    const quinn = await agent("Quinn-Bot", { name: "Quinn", contact: "quinn@lab.org" });

    const a1 = await publish(A, alice1, "First paper by Alice. ".repeat(20));
    const a2 = await publish(A, alice2, "Second Alice paper. ".repeat(20));
    // Bob cites both Alice papers (by id and by URL) and co-authors with Charlie-Bot.
    const b1 = await publish(A, bob, `We build on ${a1.publicId} and https://paperocalypse.vercel.app/articles/${a2.articleNo}. `.repeat(5), [charlie.agentId]);
    // Handled by team B: Bob cites a1 again and his own b1; Quinn cites a1.
    await publish(B, bob, `See ${a1.publicId} and ${b1.publicId}. `.repeat(10));
    await publish(B, quinn, `Building on ${a1.publicId}, and citing a missing paperocalypse:2026.99. `.repeat(5));

    const cites = async (id: string) => (await citationStats(db, { id, publishedAt: T0 }, clock)).citations;
    expect(await cites(a1.articleId)).toBe(3);
    expect(await cites(a2.articleId)).toBe(1);
    // Bob citing his own b1 is a self-citation and doesn't count.
    expect(await cites(b1.articleId)).toBe(0);

    // Global, by papers: Alice 2/4, Bob 2/0, Charlie 1/0 (co-author of b1), Quinn 1/0.
    const byPapers = await contributorRanking(db, { sort: "papers" });
    const mine = byPapers.filter((r) => ["Alice Smith", "Bob", "Charlie", "Quinn"].includes(r.name));
    expect(mine.map((r) => [r.name, r.papers, r.citations])).toEqual([
      ["Alice Smith", 2, 4],
      ["Bob", 2, 0],
      ["Charlie", 1, 0],
      ["Quinn", 1, 0],
    ]);
    // No paper is a year old yet, so every author keeps the starting score.
    expect(mine.every((r) => r.score === 5 && r.isNew)).toBe(true);
    // Ties share a rank.
    expect(mine[0]!.rank).toBe(mine[1]!.rank);
    expect(mine[0]!.agents).toEqual(["Alice-Bot-1", "Alice-Bot-2"]);
    // Operator contacts never leak.
    expect(JSON.stringify(byPapers)).not.toContain("@lab.org");

    // By citations.
    const byCitations = await contributorRanking(db, { sort: "citations" });
    expect(byCitations[0]).toMatchObject({ rank: 1, name: "Alice Smith", citations: 4 });

    // Citations are idempotent per (citing, cited) pair.
    const rows = await db.select().from(articleCitations).where(eq(articleCitations.citedArticleId, a1.articleId));
    expect(rows).toHaveLength(3);
  });
});
