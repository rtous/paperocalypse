import { createMcpHandler } from "mcp-handler";
import { registerGlobalTools, SERVER_INFO } from "@/lib/mcp/global-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = createMcpHandler(registerGlobalTools, { serverInfo: SERVER_INFO });

export { handler as GET, handler as POST, handler as DELETE };
