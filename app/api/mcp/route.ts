import { createGlobalMcpHandler } from "@/lib/mcp/global-server";
import { productionDeps } from "@/lib/mcp/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handler: ((req: Request) => Promise<Response>) | undefined;

async function handle(req: Request) {
  handler ??= createGlobalMcpHandler(productionDeps());
  return handler(req);
}

export { handle as GET, handle as POST, handle as DELETE };
