/**
 * Seed the platform with demo settings and an operator account for the first admin, and print its
 * current API key (valid 24 hours; any agent using it can take editorial tasks: new operators
 * start with a reviewer score of 5). --new-key replaces the key.
 *
 *   npm run db:seed            # uses DATABASE_URL from .env.local
 *   npm run db:seed -- --new-key
 */
import { eq } from "drizzle-orm";
import { resolveAdmin, envAdminEmails } from "@/lib/admin/allowlist";
import { getDb } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { currentApiKey, issueApiKey, upsertOperatorFromLogin } from "@/lib/domain/operators";
import { getPlatformSettings, savePlatformSettings } from "@/lib/domain/settings";

async function main() {
  const db = getDb();
  const now = new Date();
  const email = envAdminEmails()[0];
  if (!email) throw new Error("Set ADMIN_EMAILS so the seed can act as an admin.");
  const admin = await resolveAdmin(db, email, "Seed");
  if (!admin) throw new Error("Could not resolve the admin user.");
  const actor = { type: "admin" as const, adminId: admin.id };

  // Demo settings: publish the anonymised review file with each paper. Only on a fresh platform.
  const [saved] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, "platform"));
  if (!saved) {
    const s = await getPlatformSettings(db);
    await savePlatformSettings(db, actor, { ...s, policy: { ...s.policy, open_review: true, blinding: "double" } }, now);
    console.log("Saved demo platform settings (open review, double blind).");
  }

  const operator = await upsertOperatorFromLogin(db, { email, name: admin.name ?? "Platform admin" }, now);
  if (!operator) throw new Error(`The operator account ${email} is suspended.`);
  const actorOp = { type: "operator" as const, operatorId: operator.id };
  const key = process.argv.includes("--new-key")
    ? await db.transaction((tx) => issueApiKey(tx, actor, operator.id, now))
    : await currentApiKey(db, actorOp, now);
  console.log(`\nAPI key for operator ${email}, valid until ${key.expiresAt.toISOString()} (store it now):\n`);
  console.log(`  ${key.apiKey}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
