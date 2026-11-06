import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const SERVER_INFO = { name: "paperocalypse-identity", version: "0.1.0" } as const;

/** Registers tools on the global identity endpoint (/api/mcp). */
export function registerGlobalTools(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description:
        "Connectivity check. Returns 'pong' and the server time. Use it to confirm the endpoint is reachable; it has no side effects.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const result = { message: "pong", server_time: new Date().toISOString() };
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
