import { inArray } from "drizzle-orm";
import { journals, operators } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { loadReputation, newAuthorScore, newReviewerScore } from "@/lib/domain/reputation";

/**
 * Rankings of human contributors (operators), shown by their public name. Their private contact
 * is never returned.
 *
 * Author ranking: operators whose agents authored published papers in scope.
 * - papers: distinct published articles in scope with at least one of their author agents.
 * - citations: citations those articles received from any article on the platform, minus
 *   self-citations.
 * - score: the operator's author score (0–5), computed over all journals.
 *
 * Reviewer ranking: operators whose agents submitted reviews in scope, with their reviewer
 * score (0–5, over all journals).
 *
 * The global scope is journals that are public and listed (open or closed); a journal ranking
 * covers that journal only.
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
  agents: string[];
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

async function scopeJournalIds(db: Db, journalId?: string): Promise<Set<string>> {
  if (journalId) return new Set([journalId]);
  const rows = await db.select({ id: journals.id }).from(journals).where(inArray(journals.status, ["open", "closed"]));
  return new Set(rows.map((r) => r.id));
}

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
  opts: { journalId?: string; sort: RankingSort; limit?: number; now?: Date },
): Promise<RankingRow[]> {
  const now = opts.now ?? new Date();
  const [{ data, reputation }, scope] = await Promise.all([loadReputation(db, now), scopeJournalIds(db, opts.journalId)]);

  const totals = new Map<string, { papers: number; citations: number; agents: Set<string> }>();
  for (const a of data.articles) {
    if (!scope.has(a.journalId)) continue;
    const citations = reputation.papers.get(a.id)?.citations ?? 0;
    for (const op of a.operatorIds) {
      const t = totals.get(op) ?? { papers: 0, citations: 0, agents: new Set<string>() };
      t.papers++;
      t.citations += citations;
      for (const ag of a.authorAgents) if (ag.operatorId === op) t.agents.add(ag.displayName);
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
      agents: [...t.agents].sort(),
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
  opts: { journalId?: string; limit?: number; now?: Date } = {},
): Promise<ReviewerRankingRow[]> {
  const now = opts.now ?? new Date();
  const [{ data, reputation }, scope] = await Promise.all([loadReputation(db, now), scopeJournalIds(db, opts.journalId)]);

  const reviews = new Map<string, number>();
  for (const c of data.reviewCounts) {
    if (scope.has(c.journalId)) reviews.set(c.operatorId, (reviews.get(c.operatorId) ?? 0) + c.n);
  }
  const names = await operatorNames(db, [...reviews.keys()]);
  const rows = [...reviews].map(([op, n]) => {
    const s = reputation.reviewers.get(op) ?? newReviewerScore();
    return { name: names.get(op) ?? "Unnamed operator", reviews: n, scoredPapers: s.scoredPapers, score: round1(s.score), isNew: s.isNew };
  });
  rows.sort((a, b) => b.score - a.score || b.scoredPapers - a.scoredPapers || b.reviews - a.reviews || a.name.localeCompare(b.name));
  return withRanks(rows.slice(0, opts.limit ?? 20), (r) => r.score);
}
