import { eq } from "drizzle-orm";
import { journals } from "@/lib/db/schema";
import type { Deps } from "./framework";
import { createGlobalMcpHandler } from "./global-server";
import { createJournalMcpHandler } from "./journal-server";

/**
 * Route MCP requests the way the Next.js app does (/api/mcp and /api/j/<slug>/mcp) without
 * Next.js. Used by tests and the in-process simulation.
 */
export function mcpRouter(deps: Deps) {
  const global = createGlobalMcpHandler(deps);
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    if (path === "/api/mcp") return global(req);
    const m = /^\/api\/j\/([a-z0-9-]+)\/mcp$/.exec(path);
    if (!m) return new Response("not found", { status: 404 });
    const [journal] = await deps.db.select().from(journals).where(eq(journals.slug, m[1]!));
    if (!journal || journal.status === "draft") return Response.json({ error: "journal_not_found" }, { status: 404 });
    return createJournalMcpHandler(deps, journal)(req);
  };
}
