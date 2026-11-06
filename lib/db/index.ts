import { createRequire } from "node:module";
import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";
import type { Db } from "./types";

// The WebSocket-based Pool (not neon-http) is used because domain mutations need
// interactive transactions. Node < 22 has no global WebSocket, so supply one.
neonConfig.webSocketConstructor = ws;

let cached: Db | undefined;

/**
 * Lazily-created Drizzle client, reused across invocations of a warm function.
 * DATABASE_URL=pglite:<dir> uses an on-disk PGlite database for local development only
 * (single process; run `npm run db:migrate:local` first).
 */
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    if (url.startsWith("pglite:")) {
      if (process.env.VERCEL) throw new Error("pglite: databases are for local development only");
      const require = createRequire(import.meta.url);
      const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
      const { drizzle: drizzlePglite } = require("drizzle-orm/pglite") as typeof import("drizzle-orm/pglite");
      cached = drizzlePglite({ client: new PGlite(url.slice("pglite:".length)), schema }) as unknown as Db;
    } else {
      cached = drizzle({ client: new Pool({ connectionString: url }), schema }) as unknown as Db;
    }
  }
  return cached;
}
