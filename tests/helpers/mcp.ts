import { randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Db } from "@/lib/db/types";
import type { BlobGateway } from "@/lib/domain/attachments";
import { clearSettingsCache, type Deps } from "@/lib/mcp/framework";
import { mcpRouter } from "@/lib/mcp/router";

export const BASE = "http://paperocalypse.test";

/** In-memory stand-in for Vercel Blob. Tests "upload" by calling put(). */
export function fakeBlob() {
  const files = new Map<string, { bytes: Buffer; contentType: string }>();
  const gateway: BlobGateway = {
    async presignPut(pathname) {
      return `https://blob.test/upload/${pathname}?sig=fake`;
    },
    async read(pathname, maxBytes) {
      const f = files.get(pathname);
      if (!f) return null;
      return {
        bytes: f.bytes.length > maxBytes ? null : f.bytes,
        size: f.bytes.length,
        contentType: f.contentType,
        url: `https://blob.test/${pathname}`,
      };
    },
  };
  return {
    gateway,
    put: (uploadUrl: string, bytes: Buffer, contentType: string) => {
      const pathname = new URL(uploadUrl).pathname.replace(/^\/upload\//, "");
      files.set(pathname, { bytes, contentType });
    },
  };
}

export function makeDeps(db: Db, blob: BlobGateway, clock: { now: Date }): Deps {
  clearSettingsCache();
  return { db, blob, now: () => clock.now, baseUrl: BASE };
}

/** Route a request the way the Next.js app does: /api/mcp or /api/j/<slug>/mcp. */
export const router = mcpRouter;

export type ToolResult = { ok: boolean; data: Record<string, unknown> & { next_actions?: string[] }; code?: string };

export class AgentClient {
  constructor(
    readonly client: Client,
    readonly key: string | null,
  ) {}

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const r = await this.client.callTool({ name, arguments: args });
    const data = (r.structuredContent ?? JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}")) as ToolResult["data"];
    const code = (data as { error?: { code?: string } }).error?.code;
    return { ok: !r.isError, data, code };
  }

  /** Call and fail the test if the tool returned an error. */
  async must(name: string, args: Record<string, unknown> = {}) {
    const r = await this.call(name, args);
    if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.data)}`);
    return r.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  close() {
    return this.client.close();
  }
}

/** Connect an MCP client to `path` (e.g. /api/mcp or /api/j/demo/mcp), optionally with a key. */
export async function connect(handle: (req: Request) => Promise<Response>, path: string, key: string | null = null, ip = randomUUID()) {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (key) headers.authorization = `Bearer ${key}`;
  const transport = new StreamableHTTPClientTransport(new URL(BASE + path), {
    fetch: (input, init) => handle(new Request(input, init)),
    requestInit: { headers },
  });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(transport);
  return new AgentClient(client, key);
}
