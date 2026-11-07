/**
 * Shared harness for scripts/simulate.ts and scripts/loadtest.ts: database access, MCP transport
 * (in-process or HTTP) and scripted agents.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Db } from "@/lib/db/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Harness = {
  mode: "in-process" | "http";
  base: string;
  db: Db;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Number of SQL statements run so far (in-process mode only). */
  queryCount: () => number;
  close: () => Promise<void>;
  protectionHeaders: () => Record<string, string>;
};

/** `--base <url>` → HTTP mode against a deployment; otherwise in-process on a fresh PGlite DB. */
export async function createHarness(argv: string[]): Promise<Harness> {
  const baseArg = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : undefined;
  const mode = baseArg ? "http" : "in-process";
  const base = (baseArg ?? "http://sim.local").replace(/\/+$/, "");
  const protectionHeaders = (): Record<string, string> => {
    if (mode !== "http" || !new URL(base).hostname.endsWith(".vercel.app")) return {};
    if (process.env.VERCEL_PROTECTION_BYPASS) return { "x-vercel-protection-bypass": process.env.VERCEL_PROTECTION_BYPASS };
    if (process.env.VERCEL_OIDC_TOKEN) return { "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN };
    return {};
  };

  if (mode === "in-process") {
    process.env.API_KEY_PEPPER ??= "simulation-pepper-0123456789";
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const schema = await import("@/lib/db/schema");
    const { mcpRouter } = await import("@/lib/mcp/router");
    let queries = 0;
    const client = new PGlite();
    const pg = drizzle({ client, schema, logger: { logQuery: () => void queries++ } });
    await migrate(pg, { migrationsFolder: "drizzle" });
    const db = pg as unknown as Db;
    const blob = {
      presignPut: async (p: string) => `https://blob.invalid/put/${p}`,
      presignGet: async (p: string) => `https://blob.invalid/get/${p}`,
      read: async () => null,
    };
    const route = mcpRouter({ db, blob, now: () => new Date(), baseUrl: base });
    return {
      mode,
      base,
      db,
      fetch: (input, init) => route(new Request(input, init)),
      queryCount: () => queries,
      close: () => client.close(),
      protectionHeaders,
    };
  }

  const { getDb } = await import("@/lib/db");
  return {
    mode,
    base,
    db: getDb(),
    fetch: (input, init) => fetch(input, init),
    queryCount: () => 0,
    close: async () => {},
    protectionHeaders,
  };
}

/** A scripted agent: it has no identity of its own, only the API key of the operator it runs for. */
export class Agent {
  operatorId = "";
  key: string | null = null;
  rateLimitWaits = 0;
  private clients = new Map<string, Client>();
  constructor(
    readonly h: Harness,
    readonly name: string,
    readonly onWait: (msg: string) => void = () => {},
  ) {}

  private async client(path: string): Promise<Client> {
    const existing = this.clients.get(path);
    if (existing) return existing;
    const headers: Record<string, string> = { ...this.h.protectionHeaders() };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const transport = new StreamableHTTPClientTransport(new URL(this.h.base + path), {
      fetch: this.h.fetch,
      requestInit: { headers },
    });
    const c = new Client({ name: `sim-${this.name}`, version: "1.0.0" });
    await c.connect(transport);
    this.clients.set(path, c);
    return c;
  }

  /** Call a tool. Like a well-behaved agent, wait out RATE_LIMITED (retry_after_seconds) and retry. */
  async call(path: string, tool: string, input: Record<string, unknown> = {}) {
    const c = await this.client(path);
    for (let attempt = 0; ; attempt++) {
      const r = await c.callTool({ name: tool, arguments: input });
      const data = (r.structuredContent ?? {}) as any;
      const code = data?.error?.code as string | undefined;
      if (code === "RATE_LIMITED" && attempt < 5) {
        const wait = Number(data.error.retry_after_seconds ?? 5) + 1;
        this.rateLimitWaits++;
        this.onWait(`… ${this.name} rate-limited on ${tool}; waiting ${wait}s as instructed`);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      return { ok: !r.isError, data, code };
    }
  }

  async must(path: string, tool: string, input: Record<string, unknown> = {}) {
    const r = await this.call(path, tool, input);
    if (!r.ok) throw new Error(`${this.name} → ${tool} failed: ${JSON.stringify(r.data)}`);
    return r.data;
  }

  async useKey(key: string) {
    this.key = key;
    await this.close();
  }

  async close() {
    for (const c of this.clients.values()) await c.close();
    this.clients.clear();
  }
}
