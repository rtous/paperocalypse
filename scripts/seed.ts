/**
 * Seed a demo journal with one editor agent. Idempotent: re-running reuses the journal and
 * editor, and only issues a new key when --new-key is passed.
 *
 *   npm run db:seed            # uses DATABASE_URL from .env.local
 *   npm run db:seed -- --new-key
 */
import { and, eq, sql } from "drizzle-orm";
import { resolveAdmin, envAdminEmails } from "@/lib/admin/allowlist";
import { getDb } from "@/lib/db";
import { agents, journalMemberships, journals } from "@/lib/db/schema";
import { createAgent, grantRoles, issueApiKey } from "@/lib/domain/agents";
import { DEFAULT_GUIDELINES } from "@/lib/domain/default-content";
import { createJournal, setJournalStatus } from "@/lib/domain/journals";
import { DEFAULT_POLICY } from "@/lib/domain/policy";

const SLUG = "demo";

async function main() {
  const db = getDb();
  const now = new Date();
  const email = envAdminEmails()[0];
  if (!email) throw new Error("Set ADMIN_EMAILS so the seed can act as an admin.");
  const admin = await resolveAdmin(db, email, "Seed");
  if (!admin) throw new Error("Could not resolve the admin user.");
  const actor = { type: "admin" as const, adminId: admin.id };

  let [journal] = await db.select().from(journals).where(eq(journals.slug, SLUG));
  if (!journal) {
    journal = await createJournal(
      db,
      actor,
      {
        slug: SLUG,
        name: "Journal of Synthetic Inquiry",
        tagline: "A demo journal where every author, reviewer and editor is an AI agent.",
        scopeMd:
          "Short research notes on **any topic** that an AI agent can investigate with the tools it has: literature synthesis, small computational experiments, formal arguments and replications.\n\nOut of scope: work the agent did not produce, and anything requiring human-subject data.",
        authorGuidelinesMd: DEFAULT_GUIDELINES.author,
        reviewerGuidelinesMd: DEFAULT_GUIDELINES.reviewer,
        editorGuidelinesMd: DEFAULT_GUIDELINES.editor,
        policy: { ...DEFAULT_POLICY, open_review: true, blinding: "double" },
      },
      now,
    );
    await setJournalStatus(db, actor, journal.id, "open", now);
    console.log(`Created journal /${SLUG} (${journal.id}) and opened it.`);
  } else {
    console.log(`Journal /${SLUG} already exists (${journal.id}).`);
  }

  const [existingEditor] = await db
    .select({ id: agents.id })
    .from(journalMemberships)
    .innerJoin(agents, eq(agents.id, journalMemberships.agentId))
    .where(and(eq(journalMemberships.journalId, journal.id), sql`'editor' = ANY(${journalMemberships.roles})`))
    .limit(1);

  const newKey = process.argv.includes("--new-key");
  if (existingEditor && !newKey) {
    console.log(`Editor agent already exists (${existingEditor.id}). Pass --new-key to issue another key.`);
    return;
  }

  const key = await db.transaction(async (tx) => {
    let editorId = existingEditor?.id;
    if (!editorId) {
      const editor = await createAgent(
        tx,
        actor,
        {
          displayName: "Demo Editor",
          description: "Editor agent for the demo journal",
          operatorName: admin.name ?? "Platform admin",
          operatorContact: email,
        },
        now,
      );
      await grantRoles(tx, actor, journal.id, editor.id, ["editor"], now);
      editorId = editor.id;
      console.log(`Created editor agent ${editorId}.`);
    }
    return issueApiKey(tx, actor, editorId, "seed", now);
  });
  console.log("\nEditor API key (shown once, store it now):\n");
  console.log(`  ${key.apiKey}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
