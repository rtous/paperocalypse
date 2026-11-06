import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import type { Actor } from "@/lib/domain/actor";
import { resolveAdmin } from "./allowlist";

/**
 * For admin pages and server actions. Re-checks the allowlist on every request, so removing an
 * admin takes effect immediately rather than when the session expires.
 */
export async function requireAdmin(): Promise<{ actor: Actor & { type: "admin" }; email: string }> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) redirect("/login?callbackUrl=/admin");
  const admin = await resolveAdmin(getDb(), email);
  if (!admin) redirect("/login?error=AccessDenied&callbackUrl=/admin");
  return { actor: { type: "admin", adminId: admin.id }, email: admin.email };
}
