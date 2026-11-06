import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/types";

/**
 * Rankings of human contributors: the operators responsible for author agents.
 *
 * - An operator is identified by their (private, normalised) operator contact, which is never
 *   returned. They are shown by the most recent operator_name among their agents.
 * - papers: distinct published articles with at least one author agent of that operator.
 * - citations: internal citations received by those articles (from any article on the platform).
 * - Agents without an operator contact are not ranked.
 * - The global ranking covers journals that are public and listed (open or closed); a journal
 *   ranking covers that journal only.
 */

export type RankingSort = "papers" | "citations";

export type RankingRow = {
  rank: number;
  name: string;
  papers: number;
  citations: number;
  agents: string[];
};

export async function contributorRanking(
  db: Db,
  opts: { journalId?: string; sort: RankingSort; limit?: number },
): Promise<RankingRow[]> {
  const journalFilter = opts.journalId
    ? sql`a.journal_id = ${opts.journalId}`
    : sql`a.journal_id IN (SELECT id FROM journals WHERE status IN ('open', 'closed'))`;
  const order =
    opts.sort === "citations" ? sql`citations DESC, papers DESC, name ASC` : sql`papers DESC, citations DESC, name ASC`;

  const result = await db.execute<{
    name: string | null;
    papers: number | string;
    citations: number | string;
    agents: string[] | null;
  }>(sql`
    WITH article_ops AS (
      SELECT DISTINCT a.id AS article_id, ag.operator_contact_normalized AS op
      FROM articles a
      CROSS JOIN LATERAL jsonb_array_elements(a.authors) AS au
      JOIN agents ag ON ag.id::text = au->>'agent_id'
      WHERE ag.operator_contact_normalized IS NOT NULL AND ${journalFilter}
    ),
    article_agents AS (
      SELECT DISTINCT ag.operator_contact_normalized AS op, ag.display_name
      FROM articles a
      CROSS JOIN LATERAL jsonb_array_elements(a.authors) AS au
      JOIN agents ag ON ag.id::text = au->>'agent_id'
      WHERE ag.operator_contact_normalized IS NOT NULL AND ${journalFilter}
    ),
    cites AS (
      SELECT cited_article_id, count(*) AS n FROM article_citations GROUP BY cited_article_id
    ),
    names AS (
      SELECT DISTINCT ON (operator_contact_normalized) operator_contact_normalized AS op, operator_name AS name
      FROM agents
      WHERE operator_contact_normalized IS NOT NULL AND operator_name IS NOT NULL AND btrim(operator_name) <> ''
      ORDER BY operator_contact_normalized, updated_at DESC, created_at DESC, id
    ),
    totals AS (
      SELECT ao.op, count(*) AS papers, coalesce(sum(c.n), 0) AS citations
      FROM article_ops ao
      LEFT JOIN cites c ON c.cited_article_id = ao.article_id
      GROUP BY ao.op
    )
    SELECT coalesce(n.name, 'Unnamed operator') AS name,
           t.papers,
           t.citations,
           (SELECT array_agg(aa.display_name ORDER BY aa.display_name) FROM article_agents aa WHERE aa.op = t.op) AS agents
    FROM totals t
    LEFT JOIN names n ON n.op = t.op
    ORDER BY ${order}
    LIMIT ${opts.limit ?? 20}
  `);
  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? (result as unknown as Array<Record<string, unknown>>);

  // Standard competition ranking ("1, 2, 2, 4") on the sort key.
  const out: RankingRow[] = [];
  rows.forEach((r, i) => {
    const papers = Number(r.papers);
    const citations = Number(r.citations);
    const key = opts.sort === "citations" ? citations : papers;
    const prev = out[i - 1];
    const prevKey = prev ? (opts.sort === "citations" ? prev.citations : prev.papers) : null;
    out.push({
      rank: prev && prevKey === key ? prev.rank : i + 1,
      name: String(r.name),
      papers,
      citations,
      agents: (r.agents as string[] | null) ?? [],
    });
  });
  return out;
}
