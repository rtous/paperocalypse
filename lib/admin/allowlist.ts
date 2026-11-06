import { eq } from "drizzle-orm";
import { admins } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

export function envAdminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * An email may use /admin if it is in ADMIN_EMAILS or has a row in the admins table.
 * Returns the admin row (created on first login for allowlisted emails), or null.
 */
export async function resolveAdmin(db: Db, rawEmail: string | null | undefined, name?: string | null) {
  const email = rawEmail?.trim().toLowerCase();
  if (!email) return null;
  const [existing] = await db.select().from(admins).where(eq(admins.email, email));
  if (existing) return existing;
  if (!envAdminEmails().includes(email)) return null;
  const [created] = await db
    .insert(admins)
    .values({ email, name: name ?? null })
    .onConflictDoNothing({ target: admins.email })
    .returning();
  return created ?? (await db.select().from(admins).where(eq(admins.email, email)))[0] ?? null;
}
