import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Local runs read credentials from .env.local (created by `vercel env pull`).
if (!process.env.DATABASE_URL && existsSync(".env.local")) process.loadEnvFile(".env.local");

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  // Migrations use the direct (unpooled) connection when available.
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
