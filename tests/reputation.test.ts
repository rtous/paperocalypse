import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { citationStats } from "@/lib/domain/citations";
import { adjustPapercoins } from "@/lib/domain/papercoins";
import { contributorRanking, reviewerRanking } from "@/lib/domain/rankings";
import { computeReputation, loadReputation, operatorReputation, relativeScore } from "@/lib/domain/reputation";
import { submitManuscript, submitReview } from "@/lib/domain/submissions";
import { createTestDb } from "./helpers/db";
import { T0, operatorFor, createAdmin, setPolicy, decide, hours, manuscript, review, sendOut, takeReview } from "./helpers/fixtures";

const days = (d: number, from = T0) => hours(24 * d, from);

describe("relativeScore", () => {
  it("maps 0 to 0, the average to 2.5 and twice the average or more to 5", () => {
    expect(relativeScore(0, 2)).toBe(0);
    expect(relativeScore(2, 2)).toBe(2.5);
    expect(relativeScore(3, 2)).toBe(3.75);
    expect(relativeScore(4, 2)).toBe(5);
    expect(relativeScore(10, 2)).toBe(5);
  });

  it("treats everyone as average when nobody has citations", () => {
    expect(relativeScore(0, 0)).toBe(2.5);
  });
});

describe("computeReputation", () => {
  const art = (id: string, ops: string[], publishedAt = T0) => ({ id, publishedAt, operatorIds: ops });

  it("keeps the starting score of 5 until a paper completes its first year", () => {
    const rep = computeReputation(
      {
        articles: [art("p1", ["ann"]), art("p2", ["ben"])],
        citations: [{ citingId: "p2", citedId: "p1", withinFirstYear: true }],
        reviews: [{ operatorId: "rita", articleId: "p1", overallScore: 0 }],
      },
      days(364),
    );
    expect(rep.papers.get("p1")).toEqual({ citations: 1, firstYear: 1, mature: false });
    expect(rep.authors.get("ann")).toMatchObject({ score: 5, isNew: true, papers: 1, maturePapers: 0 });
    expect(rep.reviewers.get("rita")).toMatchObject({ score: 5, isNew: true, scoredPapers: 0 });
  });
});

describe("reputation from the database", () => {
  let db: Db;
  let close: () => Promise<void>;
  let admin: Actor & { type: "admin" };
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    admin = await createAdmin(db);
  });
  afterAll(async () => close());

  async function agent(_label: string, operatorName: string) {
    const op = await operatorFor(db, operatorName, { email: `${operatorName.toLowerCase()}@lab.org` });
    await adjustPapercoins(db, admin, op.id, 100, "test balance", T0);
    return { type: "operator" as const, operatorId: op.id };
  }

  it("scores papers, authors and reviewers from first-year citations", async () => {
    await setPolicy(db, { max_submissions_per_operator_per_day: 50, max_open_submissions_per_operator: 50 });
    const editor = await agent("Editor-Bot", "Eve");
    const rita = await agent("Rita-Bot", "Rita");
    const rex = await agent("Rex-Bot", "Rex");
    const ann = await agent("Ann-Bot", "Ann");
    const ben = await agent("Ben-Bot", "Ben");
    const cat = await agent("Cat-Bot", "Cat");

    /** Publish a paper at `at`; Rita and Rex give the overall scores in `scores`. */
    async function publish(author: Actor & { type: "operator" }, body: string, at: Date, scores: [number, number]) {
      const { submissionId } = await submitManuscript(db, author, manuscript({ bodyMd: body }), at);
      await sendOut(db, editor, submissionId, at);
      for (const [i, r] of [rita, rex].entries()) {
        await submitReview(db, r, await takeReview(db, r, submissionId, at), review({ overallScore: scores[i]! }), at);
      }
      return (await decide(db, editor, submissionId, "accept", at)).article!;
    }

    const p1 = await publish(ann, "Ann's first paper. ".repeat(20), T0, [5, 0]);
    await publish(ben, "Ben's paper. ".repeat(20), hours(1), [1, 5]);
    // Within p1's first year: Cat cites it (counts), Ann cites her own paper (self-citation).
    await publish(cat, `Cat builds on ${p1.publicId}. `.repeat(5), days(100), [0, 5]);
    await publish(ann, `Ann extends ${p1.publicId}. `.repeat(5), days(200), [0, 5]);
    // After p1's first year: counts as a citation, not a first-year one.
    await publish(ben, `Ben revisits ${p1.publicId}. `.repeat(5), days(400), [0, 5]);

    // Paper score.
    const p1Stats = await citationStats(db, { id: p1.articleId, publishedAt: T0 }, days(800));
    expect(p1Stats).toMatchObject({ citations: 2, firstYear: 1, firstYearComplete: true });
    expect((await citationStats(db, { id: p1.articleId, publishedAt: T0 }, days(300))).firstYearComplete).toBe(false);

    // Before any paper is a year old, everyone has 5.
    const early = await loadReputation(db, days(300));
    for (const op of [ann, ben, cat]) expect(early.reputation.authors.get(op.operatorId)).toMatchObject({ score: 5, isNew: true });
    for (const op of [rita, rex]) expect(early.reputation.reviewers.get(op.operatorId)).toMatchObject({ score: 5, isNew: true });

    // Two years on, every paper is mature. 1YP: p1 = 1, the other four = 0 (paper average 0.2).
    const now = days(800);
    const { reputation } = await loadReputation(db, now);
    expect(reputation.averages.paperFirstYear).toBeCloseTo(0.2);
    // Author 1YP: Ann (p1, p4) 0.5, Ben 0, Cat 0; average 1/6. Ann is over twice the average.
    expect(reputation.averages.authorFirstYear).toBeCloseTo(1 / 6);
    expect(reputation.authors.get(ann.operatorId)).toMatchObject({ score: 5, isNew: false, papers: 2, maturePapers: 2, firstYearMean: 0.5 });
    expect(reputation.authors.get(ben.operatorId)).toMatchObject({ score: 0, isNew: false });
    expect(reputation.authors.get(cat.operatorId)).toMatchObject({ score: 0, isNew: false });
    // Earned paper scores: p1 = 5, others = 0. Rita: gaps 0, 1, 0, 0, 0 → 4.8. Rex: all 5 → 0.
    expect(reputation.reviewers.get(rita.operatorId)!.score).toBeCloseTo(4.8);
    expect(reputation.reviewers.get(rita.operatorId)!.scoredPapers).toBe(5);
    expect(reputation.reviewers.get(rex.operatorId)!.score).toBeCloseTo(0);

    // Operators without papers or reviews get the starting score.
    const eve = await operatorReputation(db, editor.operatorId, now);
    expect(eve.author).toMatchObject({ score: 5, isNew: true });
    expect(eve.reviewer).toMatchObject({ score: 5, isNew: true });

    // Rankings.
    const authors = await contributorRanking(db, { sort: "score", now });
    expect(authors.map((r) => [r.name, r.score, r.papers, r.citations])).toEqual([
      ["Ann", 5, 2, 2],
      ["Ben", 0, 2, 0],
      ["Cat", 0, 1, 0],
    ]);
    expect(authors.map((r) => r.rank)).toEqual([1, 2, 2]);
    const reviewers = await reviewerRanking(db, { now });
    expect(reviewers.map((r) => [r.name, r.score, r.reviews, r.scoredPapers])).toEqual([
      ["Rita", 4.8, 5, 5],
      ["Rex", 0, 5, 5],
    ]);
  });

  it("rejects overall scores outside 0–5", async () => {
    await setPolicy(db);
    const editor = await agent("Ed2", "Ed2");
    const r = await agent("Rv2", "Rv2");
    const au = await agent("Au2", "Au2");
    const { submissionId } = await submitManuscript(db, au, manuscript(), T0);
    await sendOut(db, editor, submissionId, T0);
    const assignmentId = await takeReview(db, r, submissionId, T0);
    for (const bad of [-1, 6, 2.5]) {
      await expect(submitReview(db, r, assignmentId, review({ overallScore: bad }), T0)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
  });
});
