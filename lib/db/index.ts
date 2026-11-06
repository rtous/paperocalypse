import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

// The WebSocket-based Pool (not neon-http) is used because domain mutations need
// interactive transactions. Node < 22 has no global WebSocket, so supply one.
neonConfig.webSocketConstructor = ws;

let cached: ReturnType<typeof createDb> | undefined;

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return drizzle({ client: new Pool({ connectionString: url }), schema });
}

/** Lazily-created Drizzle client, reused across invocations of a warm function. */
export function getDb() {
  cached ??= createDb();
  return cached;
}
