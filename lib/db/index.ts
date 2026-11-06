import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";
import type { Db } from "./types";

// The WebSocket-based Pool (not neon-http) is used because domain mutations need
// interactive transactions. Node < 22 has no global WebSocket, so supply one.
neonConfig.webSocketConstructor = ws;

let cached: Db | undefined;

/** Lazily-created Drizzle client, reused across invocations of a warm function. */
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cached = drizzle({ client: new Pool({ connectionString: url }), schema }) as unknown as Db;
  }
  return cached;
}
