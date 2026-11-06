import { describe, expect, it } from "vitest";
import { createMcpHandler } from "mcp-handler";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { registerGlobalTools, SERVER_INFO } from "@/lib/mcp/global-server";

describe("global MCP endpoint", () => {
  it("lists and calls the ping tool", async () => {
    const handler = createMcpHandler(registerGlobalTools, { serverInfo: SERVER_INFO });
    const transport = new StreamableHTTPClientTransport(new URL("http://test.local/api/mcp"), {
      fetch: (input, init) => handler(new Request(input, init)),
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("ping");

    const res = await client.callTool({ name: "ping", arguments: {} });
    expect(res.structuredContent).toMatchObject({ message: "pong" });
    await client.close();
  });
});
