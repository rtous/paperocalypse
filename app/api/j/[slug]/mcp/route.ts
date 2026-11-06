import { eq } from "drizzle-orm";
import { journals } from "@/lib/db/schema";
import { productionDeps } from "@/lib/mcp/deps";
import { createJournalMcpHandler } from "@/lib/mcp/journal-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-journal MCP endpoint. The journal is loaded on every request (stateless) and a fresh
 * MCP server is built for it, so policy and guideline edits take effect immediately.
 */
async function handle(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const deps = productionDeps();
  const [journal] = /^[a-z0-9-]{1,40}$/.test(slug)
    ? await deps.db.select().from(journals).where(eq(journals.slug, slug))
    : [];
  if (!journal || journal.status === "draft") {
    return Response.json(
      { error: "journal_not_found", message: `No journal "${slug}". Call list_journals on ${deps.baseUrl}/api/mcp.` },
      { status: 404 },
    );
  }
  return createJournalMcpHandler(deps, journal)(req);
}

export { handle as GET, handle as POST, handle as DELETE };
