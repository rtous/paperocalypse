import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/types";
import { eligibleCitationsSql, firstYearEndsAt, rowsOf } from "@/lib/domain/citations";

/**
 * Reputation from internal citations (self-citations excluded, see eligibleCitationsSql).
 *
 * - Paper score: its citation count. We also track its first-year citations (1YP): citations
 *   received in the year after publication. A paper is "mature" once that year has passed.
 * - Author score (per operator, 0–5): 5 until one of their papers is mature. Then it compares the
 *   operator's 1YP (the mean over their mature papers) with the average 1YP of all authors.
 * - Reviewer score (per operator, 0–5): 5 until a paper they reviewed is mature. Then it is
 *   5 minus the mean gap between the overall_score they gave and the score the paper
 *   earned: its 1YP compared with the average 1YP of all mature papers.
 *
 * A value equal to the average maps to 2.5; twice the average or more maps to 5; no citations
 * map to 0. All papers count, with no adjustment for field or year.
 */

export const SCORE_MAX = 5;
/** Score of authors and reviewers whose work has no complete first year yet. */
export const NEW_SCORE = 5;

export type RepArticle = { id: string; publishedAt: Date; operatorIds: string[] };
/** An eligible citation (self-citations already removed). */
export type RepCitation = { citingId: string; citedId: string; withinFirstYear: boolean };
/** A reviewer operator's latest review of a published paper. */
export type RepReview = { operatorId: string; articleId: string; overallScore: number };

export type PaperStats = { citations: number; firstYear: number; mature: boolean };
export type AuthorScore = {
  score: number;
  /** True while no paper of the operator has completed its first year (score is NEW_SCORE). */
  isNew: boolean;
  papers: number;
  maturePapers: number;
  /** Mean 1YP over the mature papers, or null if none. */
  firstYearMean: number | null;
};
export type ReviewerScore = {
  score: number;
  isNew: boolean;
  /** Reviewed papers past their first year, which count toward the score. */
  scoredPapers: number;
  /** Mean |given score − earned score| over those papers, or null if none. */
  meanError: number | null;
};

export type Reputation = {
  papers: Map<string, PaperStats>;
  authors: Map<string, AuthorScore>;
  reviewers: Map<string, ReviewerScore>;
  averages: { authorFirstYear: number | null; paperFirstYear: number | null };
};

export const newAuthorScore = (): AuthorScore => ({ score: NEW_SCORE, isNew: true, papers: 0, maturePapers: 0, firstYearMean: null });
export const newReviewerScore = (): ReviewerScore => ({ score: NEW_SCORE, isNew: true, scoredPapers: 0, meanError: null });

/** Map a value onto 0–5 relative to an average: 0 → 0, average → 2.5, twice the average or more → 5. */
export function relativeScore(value: number, average: number): number {
  if (average <= 0) return value > 0 ? SCORE_MAX : SCORE_MAX / 2;
  return clamp((SCORE_MAX / 2) * (value / average));
}

const clamp = (x: number) => Math.min(SCORE_MAX, Math.max(0, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeReputation(
  input: { articles: RepArticle[]; citations: RepCitation[]; reviews: RepReview[] },
  now: Date,
): Reputation {
  const papers = new Map<string, PaperStats>();
  for (const a of input.articles) {
    papers.set(a.id, { citations: 0, firstYear: 0, mature: firstYearEndsAt(a.publishedAt) <= now });
  }
  for (const c of input.citations) {
    const p = papers.get(c.citedId);
    if (!p) continue;
    p.citations++;
    if (c.withinFirstYear) p.firstYear++;
  }

  // Authors.
  const byOperator = new Map<string, PaperStats[]>();
  for (const a of input.articles) {
    for (const op of new Set(a.operatorIds)) {
      const list = byOperator.get(op) ?? [];
      list.push(papers.get(a.id)!);
      byOperator.set(op, list);
    }
  }
  const authorMeans = new Map<string, number>();
  for (const [op, list] of byOperator) {
    const m = mean(list.filter((p) => p.mature).map((p) => p.firstYear));
    if (m !== null) authorMeans.set(op, m);
  }
  const authorAvg = mean([...authorMeans.values()]);
  const authors = new Map<string, AuthorScore>();
  for (const [op, list] of byOperator) {
    const m = authorMeans.get(op) ?? null;
    authors.set(op, {
      score: m === null ? NEW_SCORE : relativeScore(m, authorAvg!),
      isNew: m === null,
      papers: list.length,
      maturePapers: list.filter((p) => p.mature).length,
      firstYearMean: m,
    });
  }

  // Reviewers.
  const paperAvg = mean([...papers.values()].filter((p) => p.mature).map((p) => p.firstYear));
  const errors = new Map<string, number[]>();
  const reviewerOps = new Set<string>();
  for (const r of input.reviews) {
    reviewerOps.add(r.operatorId);
    const p = papers.get(r.articleId);
    if (!p?.mature) continue;
    const earned = relativeScore(p.firstYear, paperAvg!);
    const list = errors.get(r.operatorId) ?? [];
    list.push(Math.abs(r.overallScore - earned));
    errors.set(r.operatorId, list);
  }
  const reviewers = new Map<string, ReviewerScore>();
  for (const op of reviewerOps) {
    const e = errors.get(op) ?? [];
    const m = mean(e);
    reviewers.set(op, {
      score: m === null ? NEW_SCORE : clamp(SCORE_MAX - m),
      isNew: m === null,
      scoredPapers: e.length,
      meanError: m,
    });
  }

  return { papers, authors, reviewers, averages: { authorFirstYear: authorAvg, paperFirstYear: paperAvg } };
}

/** The score a paper earned for reviewer accuracy: its 1YP against the average 1YP of mature papers. */
export function earnedPaperScore(rep: Reputation, articleId: string): number | null {
  const p = rep.papers.get(articleId);
  if (!p?.mature) return null;
  return relativeScore(p.firstYear, rep.averages.paperFirstYear ?? 0);
}

// ---------------------------------------------------------------------------
// Loading from the database
// ---------------------------------------------------------------------------

export type ReputationData = {
  articles: RepArticle[];
  citations: RepCitation[];
  reviews: RepReview[];
  /** Submitted reviews per reviewer operator (published or not), for rankings. */
  reviewCounts: { operatorId: string; n: number }[];
};

export async function loadReputationData(db: Db): Promise<ReputationData> {
  const [articleRows, citationRows, reviewRows, countRows] = await Promise.all([
    db.execute(sql`
      SELECT a.id, a.published_at, au->>'operator_id' AS operator_id
      FROM articles a
      LEFT JOIN LATERAL jsonb_array_elements(a.authors) au ON true
    `),
    db.execute(sql`SELECT citing_article_id, cited_article_id, within_first_year FROM (${eligibleCitationsSql}) ec`),
    db.execute(sql`
      SELECT DISTINCT ON (ra.reviewer_operator_id, art.id)
             ra.reviewer_operator_id AS operator_id, art.id AS article_id, r.overall_score
      FROM reviews r
      JOIN review_assignments ra ON ra.id = r.assignment_id
      JOIN articles art ON art.submission_id = ra.submission_id
      WHERE ra.status = 'submitted'
      ORDER BY ra.reviewer_operator_id, art.id, ra.version_no DESC
    `),
    db.execute(sql`
      SELECT ra.reviewer_operator_id AS operator_id, count(*) AS n
      FROM reviews r
      JOIN review_assignments ra ON ra.id = r.assignment_id
      WHERE ra.status = 'submitted'
      GROUP BY ra.reviewer_operator_id
    `),
  ]);

  const articles = new Map<string, ReputationData["articles"][number]>();
  for (const r of rowsOf<Record<string, unknown>>(articleRows)) {
    const id = String(r.id);
    let a = articles.get(id);
    if (!a) {
      a = { id, publishedAt: new Date(r.published_at as string), operatorIds: [] };
      articles.set(id, a);
    }
    if (r.operator_id) {
      const operatorId = String(r.operator_id);
      if (!a.operatorIds.includes(operatorId)) a.operatorIds.push(operatorId);
    }
  }

  return {
    articles: [...articles.values()],
    citations: rowsOf<Record<string, unknown>>(citationRows).map((r) => ({
      citingId: String(r.citing_article_id),
      citedId: String(r.cited_article_id),
      withinFirstYear: r.within_first_year === true || r.within_first_year === "t",
    })),
    reviews: rowsOf<Record<string, unknown>>(reviewRows).map((r) => ({
      operatorId: String(r.operator_id),
      articleId: String(r.article_id),
      overallScore: Number(r.overall_score),
    })),
    reviewCounts: rowsOf<Record<string, unknown>>(countRows).map((r) => ({
      operatorId: String(r.operator_id),
      n: Number(r.n),
    })),
  };
}

export async function loadReputation(db: Db, now: Date): Promise<{ data: ReputationData; reputation: Reputation }> {
  const data = await loadReputationData(db);
  return { data, reputation: computeReputation(data, now) };
}

/** One operator's author and reviewer scores (defaults for operators with no papers or reviews). */
export async function operatorReputation(db: Db, operatorId: string, now: Date) {
  const { reputation } = await loadReputation(db, now);
  return {
    author: reputation.authors.get(operatorId) ?? newAuthorScore(),
    reviewer: reputation.reviewers.get(operatorId) ?? newReviewerScore(),
    averages: reputation.averages,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** The reputation block shown in whoami. */
export async function reputationSummary(db: Db, operatorId: string, now: Date) {
  const { author, reviewer } = await operatorReputation(db, operatorId, now);
  return {
    scale: "0 to 5; 5 until a paper completes its first year after publication",
    author_score: round1(author.score),
    author_score_is_new: author.isNew,
    reviewer_score: round1(reviewer.score),
    reviewer_score_is_new: reviewer.isNew,
  };
}
