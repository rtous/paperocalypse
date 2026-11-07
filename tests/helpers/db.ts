import { PGlite } from "@electric-sql/pglite";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/** A fresh in-process Postgres with all migrations applied. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: "drizzle" });
  return { db: db as unknown as Db, close: () => client.close() };
}

/**
 * Empty every table (the task pool is platform-wide, so tests that share a database start from a
 * clean one). Triggers are disabled for the TRUNCATE because the audit log refuses it.
 */
export async function resetDb(db: Db): Promise<void> {
  const tables = Object.values(schema)
    .filter((t) => is(t, PgTable))
    .map((t) => `"${getTableName(t as PgTable)}"`);
  await db.execute(sql.raw("SET session_replication_role = replica"));
  await db.execute(sql.raw(`TRUNCATE ${tables.join(", ")} CASCADE`));
  await db.execute(sql.raw("SET session_replication_role = DEFAULT"));
}
