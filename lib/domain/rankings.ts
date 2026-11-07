import { inArray } from "drizzle-orm";
import { operators } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { loadReputation, newAuthorScore, newReviewerScore } from "@/lib/domain/reputation";

/**
 * Rankings of human contributors (operators), shown by their public name. Their private contact
 * is never returned.
 *
 * Author ranking: operators who authored published papers.
 * - papers: distinct published articles they co-authored.
 * - citations: citations those articles received from other articles on the platform, minus
 *   self-citations.
 * - score: the operator's author score (0–5).
 *
 * Reviewer ranking: operators who submitted reviews, with their reviewer score (0–5).
 */

export type RankingSort = "score" | "papers" | "citations";

export type RankingRow = {
  rank: number;
  name: string;
  papers: number;
  citations: number;
  score: number;
  /** No paper has completed its first year yet, so the score is the starting value. */
  isNew: boolean;
};

export type ReviewerRankingRow = {
  rank: number;
  name: string;
  reviews: number;
  /** Mature published papers whose review counts toward the score. */
  scoredPapers: number;
  score: number;
  isNew: boolean;
};

async function operatorNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: operators.id, name: operators.name }).from(operators).where(inArray(operators.id, ids));
  return new Map(rows.map((r) => [r.id, r.name.trim() || "Unnamed operator"]));
}

/** Standard competition ranking ("1, 2, 2, 4") on a sort key, after sorting. */
function withRanks<T extends object>(rows: T[], key: (r: T) => number): (T & { rank: number })[] {
  const out: (T & { rank: number })[] = [];
  rows.forEach((r, i) => {
    const prev = out[i - 1];
    out.push({ ...r, rank: prev && key(prev) === key(r) ? prev.rank : i + 1 });
  });
  return out;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export async function contributorRanking(
  db: Db,
  opts: { sort: RankingSort; limit?: number; now?: Date },
): Promise<RankingRow[]> {
  const now = opts.now ?? new Date();
  const { data, reputation } = await loadReputation(db, now);

  const totals = new Map<string, { papers: number; citations: number }>();
  for (const a of data.articles) {
    const citations = reputation.papers.get(a.id)?.citations ?? 0;
    for (const op of a.operatorIds) {
      const t = totals.get(op) ?? { papers: 0, citations: 0 };
      t.papers++;
      t.citations += citations;
      totals.set(op, t);
    }
  }
  const names = await operatorNames(db, [...totals.keys()]);

  const rows = [...totals].map(([op, t]) => {
    const s = reputation.authors.get(op) ?? newAuthorScore();
    return {
      name: names.get(op) ?? "Unnamed operator",
      papers: t.papers,
      citations: t.citations,
      score: round1(s.score),
      isNew: s.isNew,
    };
  });
  const key = (r: (typeof rows)[number]) => (opts.sort === "score" ? r.score : opts.sort === "citations" ? r.citations : r.papers);
  rows.sort(
    (a, b) =>
      key(b) - key(a) || b.score - a.score || b.citations - a.citations || b.papers - a.papers || a.name.localeCompare(b.name),
  );
  return withRanks(rows.slice(0, opts.limit ?? 20), key);
}

export async function reviewerRanking(
  db: Db,
  opts: { limit?: number; now?: Date } = {},
): Promise<ReviewerRankingRow[]> {
  const now = opts.now ?? new Date();
  const { data, reputation } = await loadReputation(db, now);

  const reviews = new Map(data.reviewCounts.map((c) => [c.operatorId, c.n]));
  const names = await operatorNames(db, [...reviews.keys()]);
  const rows = [...reviews].map(([op, n]) => {
    const s = reputation.reviewers.get(op) ?? newReviewerScore();
    return { name: names.get(op) ?? "Unnamed operator", reviews: n, scoredPapers: s.scoredPapers, score: round1(s.score), isNew: s.isNew };
  });
  rows.sort((a, b) => b.score - a.score || b.scoredPapers - a.scoredPapers || b.reviews - a.reviews || a.name.localeCompare(b.name));
  return withRanks(rows.slice(0, opts.limit ?? 20), (r) => r.score);
}
