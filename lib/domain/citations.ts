import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { articleCitations, articles, journals } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Internal citations: references from a published article to other articles published on this
 * platform. Recognised forms (anywhere in the text):
 *   - permanent ids:  paperocalypse:<slug>.<year>.<n>
 *   - article URLs:   .../j/<slug>/articles/<n>   (any host, so links still count across domains)
 */

export type CitationRef = { publicId: string } | { slug: string; articleNo: number };

const PUBLIC_ID = /paperocalypse:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.(\d{4})\.(\d{1,7})\b/g;
const ARTICLE_URL = /\/j\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/articles\/(\d{1,7})\b/g;

export function extractCitationRefs(text: string): CitationRef[] {
  const refs = new Map<string, CitationRef>();
  for (const m of text.matchAll(PUBLIC_ID)) {
    const publicId = `paperocalypse:${m[1]}.${m[2]}.${Number(m[3])}`;
    refs.set(publicId, { publicId });
  }
  for (const m of text.matchAll(ARTICLE_URL)) {
    const key = `${m[1]}#${Number(m[2])}`;
    refs.set(key, { slug: m[1]!, articleNo: Number(m[2]) });
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
  if (ids.length) conds.push(inArray(articles.publicId, ids));
  for (const r of refs) {
    if ("slug" in r) conds.push(and(eq(journals.slug, r.slug), eq(articles.articleNo, r.articleNo))!);
  }
  const cited = await tx
    .selectDistinct({ id: articles.id })
    .from(articles)
    .innerJoin(journals, eq(journals.id, articles.journalId))
    .where(and(or(...conds), ne(articles.id, citingArticleId)));
  if (cited.length === 0) return 0;
  const inserted = await tx
    .insert(articleCitations)
    .values(cited.map((c) => ({ citingArticleId, citedArticleId: c.id, createdAt: now, updatedAt: now })))
    .onConflictDoNothing()
    .returning({ id: articleCitations.citedArticleId });
  return inserted.length;
}

/** Number of internal citations per article (for article pages and get_article). */
export async function citationCount(db: Db, articleId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(articleCitations)
    .where(eq(articleCitations.citedArticleId, articleId));
  return r?.n ?? 0;
}
