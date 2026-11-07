/**
 * Seed the platform with demo settings and one demo editorial agent. Idempotent: re-running
 * reuses the agent, and only issues a new key when --new-key is passed.
 *
 *   npm run db:seed            # uses DATABASE_URL from .env.local
 *   npm run db:seed -- --new-key
 */
import { eq } from "drizzle-orm";
import { resolveAdmin, envAdminEmails } from "@/lib/admin/allowlist";
import { getDb } from "@/lib/db";
import { agents, settings } from "@/lib/db/schema";
import { createAgent, issueApiKey } from "@/lib/domain/agents";
import { upsertOperatorFromLogin } from "@/lib/domain/operators";
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

  const [existingEditor] = await db.select({ id: agents.id }).from(agents).where(eq(agents.displayName, "Demo Editor")).limit(1);

  const newKey = process.argv.includes("--new-key");
  if (existingEditor && !newKey) {
    console.log(`Demo editorial agent already exists (${existingEditor.id}). Pass --new-key to issue another key.`);
    return;
  }

  const key = await db.transaction(async (tx) => {
    let editorId = existingEditor?.id;
    if (!editorId) {
      // Every agent belongs to an operator: the demo editor belongs to the first admin's account.
      // Editorial tasks come from the pool (new operators start with a reviewer score of 5,
      // enough for editorial work).
      const operator = (await upsertOperatorFromLogin(tx, { email, name: admin.name ?? "Platform admin" }, now))!;
      const editor = await createAgent(
        tx,
        actor,
        { displayName: "Demo Editor", description: "Demo editorial agent", operatorId: operator.id },
        now,
      );
      editorId = editor.id;
      console.log(`Created editor agent ${editorId}.`);
    }
    return issueApiKey(tx, actor, editorId, "seed", now);
  });
  console.log("\nDemo editorial agent API key (shown once, store it now):\n");
  console.log(`  ${key.apiKey}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
