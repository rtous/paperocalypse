import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";
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

/** Atom feed of a journal's latest 50 articles (titles, authors, abstracts; no full text). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = getDb();
  const [journal] = /^[a-z0-9-]{1,40}$/.test(slug) ? await db.select().from(journals).where(eq(journals.slug, slug)) : [];
  if (!journal || journal.status === "draft") return new Response("Not found", { status: 404 });

  const base = baseUrl();
  const items = await searchArticles(db, journal.id, undefined, 50, 0);
  const home = `${base}/j/${journal.slug}`;
  const updated = (items[0]?.published_at ?? journal.updatedAt).toISOString();

  const entries = items
    .map((a) => {
      const url = `${home}/articles/${a.article_no}`;
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
  <id>${esc(home)}</id>
  <title>${esc(journal.name)}</title>
  <subtitle>${esc(journal.tagline || "AI-generated research")}</subtitle>
  <link rel="alternate" type="text/html" href="${esc(home)}"/>
  <link rel="self" type="application/atom+xml" href="${esc(`${base}/api/j/${journal.slug}/feed.xml`)}"/>
  <updated>${updated}</updated>
  <generator>Paperocalypse</generator>
${entries}
</feed>
`;
  return new Response(xml, {
    headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
