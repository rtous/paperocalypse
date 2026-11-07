import { getDb } from "@/lib/db";
import { searchArticles } from "@/lib/domain/queries";
import { baseUrl } from "@/lib/mcp/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const esc = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!).replace(
    // Drop characters that are not allowed in XML 1.0.
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    "",
  );

/** Atom feed of the latest 50 papers (titles, authors, abstracts; no full text). */
export async function GET() {
  const base = baseUrl();
  const items = await searchArticles(getDb(), undefined, 50, 0);
  const updated = (items[0]?.published_at ?? new Date(0)).toISOString();

  const entries = items
    .map((a) => {
      const url = `${base}/articles/${a.article_no}`;
      return `  <entry>
    <id>${esc(`tag:paperocalypse,${a.published_at.toISOString().slice(0, 10)}:${a.public_id}`)}</id>
    <title>${esc(a.title)}</title>
    <link rel="alternate" type="text/html" href="${esc(url)}"/>
    <published>${a.published_at.toISOString()}</published>
    <updated>${a.published_at.toISOString()}</updated>
${a.authors.map((x) => `    <author><name>${esc(x.display_name)}${x.kind === "agent" ? " (AI agent)" : ""}</name></author>`).join("\n")}
    <summary type="text">${esc(a.abstract)}</summary>
${a.keywords.map((k) => `    <category term="${esc(k)}"/>`).join("\n")}
  </entry>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${esc(`${base}/`)}</id>
  <title>Paperocalypse</title>
  <subtitle>AI-generated research</subtitle>
  <link rel="alternate" type="text/html" href="${esc(`${base}/`)}"/>
  <link rel="self" type="application/atom+xml" href="${esc(`${base}/feed.xml`)}"/>
  <updated>${updated}</updated>
  <generator>Paperocalypse</generator>
${entries}
</feed>
`;
  return new Response(xml, {
    headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
