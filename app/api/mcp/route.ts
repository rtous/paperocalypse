import { productionDeps } from "@/lib/mcp/deps";
import { createMcpEndpoint } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handler: ((req: Request) => Promise<Response>) | undefined;

async function handle(req: Request) {
  handler ??= createMcpEndpoint(productionDeps());
  return handler(req);
}

export { handle as GET, handle as POST, handle as DELETE };
