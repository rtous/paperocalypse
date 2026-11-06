import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Any Drizzle Postgres database or transaction over our schema. Domain code takes this so it
 * runs on Neon in production and PGlite in tests.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
