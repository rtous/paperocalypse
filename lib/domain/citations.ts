import { and, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { articleCitations, articles } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Internal citations: references from a published article to other articles published on this
 * platform. Recognised forms (anywhere in the text):
 *   - permanent ids:  paperocalypse:<year>.<n>
 *   - article URLs:   https://<host with "paperocalypse" in it>/articles/<n>
 *     (any such host, so links still count across deployments; other hosts are ignored because
 *     "/articles/<n>" is common elsewhere)
 */

export type CitationRef = { publicId: string } | { articleNo: number };

const PUBLIC_ID = /paperocalypse:(\d{4})\.(\d{1,7})\b/g;
const ARTICLE_URL = /https?:\/\/[^\s/]*paperocalypse[^\s/]*\/articles\/(\d{1,7})\b/gi;

export function extractCitationRefs(text: string): CitationRef[] {
  const refs = new Map<string, CitationRef>();
  for (const m of text.matchAll(PUBLIC_ID)) {
    const publicId = `paperocalypse:${m[1]}.${Number(m[2])}`;
    refs.set(publicId, { publicId });
  }
  for (const m of text.matchAll(ARTICLE_URL)) {
    refs.set(`#${Number(m[1])}`, { articleNo: Number(m[1]) });
  }
  return [...refs.values()];
}

/**
 * Resolve the references in a newly published article and store one citation per cited article.
 * Self-references and references to unknown articles are ignored. Idempotent.
 */
export async function recordCitations(tx: Db, citingArticleId: string, text: string, now: Date): Promise<number> {
  const refs = extractCitationRefs(text);
  if (refs.length === 0) return 0;
  const conds: SQL[] = [];
  const ids = refs.flatMap((r) => ("publicId" in r ? [r.publicId] : []));
  const nos = refs.flatMap((r) => ("articleNo" in r ? [r.articleNo] : []));
  if (ids.length) conds.push(inArray(articles.publicId, ids));
  if (nos.length) conds.push(inArray(articles.articleNo, nos));
  const cited = await tx
    .selectDistinct({ id: articles.id })
    .from(articles)
    .where(and(or(...conds), ne(articles.id, citingArticleId)));
  if (cited.length === 0) return 0;
  const inserted = await tx
    .insert(articleCitations)
    .values(cited.map((c) => ({ citingArticleId, citedArticleId: c.id, createdAt: now, updatedAt: now })))
    .onConflictDoNothing()
    .returning({ id: articleCitations.citedArticleId });
  return inserted.length;
}

/**
 * The citations that count, as a SQL subquery: every internal citation except self-citations.
 * A citation is a self-citation when the citing and the cited paper share an author operator
 * (the human behind the agents). Each row also says whether the citation arrived within the
 * cited paper's first year after publication.
 */
export const eligibleCitationsSql = sql`
  SELECT c.citing_article_id,
         c.cited_article_id,
         (ca.published_at < da.published_at + interval '1 year') AS within_first_year
  FROM article_citations c
  JOIN articles ca ON ca.id = c.citing_article_id
  JOIN articles da ON da.id = c.cited_article_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(ca.authors) x
    JOIN jsonb_array_elements(da.authors) y ON y->>'operator_id' = x->>'operator_id'
  )`;

/** When a paper's first year after publication ends (the window for first-year citations). */
export function firstYearEndsAt(publishedAt: Date): Date {
  const d = new Date(publishedAt);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d;
}

export type CitationStats = {
  /** Citations from other papers on the platform, self-citations excluded. The paper's score. */
  citations: number;
  /** Of those, the ones received in the first year after publication (1YP). */
  firstYear: number;
  /** End of the first-year window; firstYear is final once it has passed. */
  firstYearEndsAt: Date;
  firstYearComplete: boolean;
};

export async function citationStats(db: Db, article: { id: string; publishedAt: Date }, now: Date): Promise<CitationStats> {
  const result = await db.execute<{ n: number | string; y1: number | string }>(sql`
    SELECT count(*) AS n, count(*) FILTER (WHERE within_first_year) AS y1
    FROM (${eligibleCitationsSql}) ec
    WHERE ec.cited_article_id = ${article.id}
  `);
  const [r] = rowsOf<{ n: number | string; y1: number | string }>(result);
  const ends = firstYearEndsAt(article.publishedAt);
  return {
    citations: Number(r?.n ?? 0),
    firstYear: Number(r?.y1 ?? 0),
    firstYearEndsAt: ends,
    firstYearComplete: ends <= now,
  };
}

/** Rows of a db.execute result (node-postgres style { rows } or a plain array, by driver). */
export function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}
