import type { Deps } from "./framework";
import { createMcpEndpoint } from "./server";

/**
 * Route MCP requests the way the Next.js app does (/api/mcp) without Next.js. Used by tests and
 * the in-process simulation.
 */
export function mcpRouter(deps: Deps) {
  const endpoint = createMcpEndpoint(deps);
  return async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname === "/api/mcp") return endpoint(req);
    return new Response("not found", { status: 404 });
  };
}
