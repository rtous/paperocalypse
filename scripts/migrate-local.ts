/** Apply migrations to a local PGlite database: DATABASE_URL=pglite:./.pglite npm run db:migrate:local */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("pglite:")) throw new Error("Set DATABASE_URL=pglite:<dir>");
async function main() {
  const client = new PGlite(url.slice("pglite:".length));
  await migrate(drizzle({ client }), { migrationsFolder: "drizzle" });
  await client.close();
  console.log(`Migrated ${url}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
