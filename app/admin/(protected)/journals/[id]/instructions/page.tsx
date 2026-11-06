import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { InstructionsEditor } from "@/components/admin/instructions-editor";
import { PageTitle } from "@/components/admin/page-title";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";
import { DEFAULT_INSTRUCTIONS_TEMPLATE, PLACEHOLDERS } from "@/lib/domain/instructions";

export default async function InstructionsAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [journal] = await getDb().select().from(journals).where(eq(journals.id, id));
  if (!journal) notFound();
  return (
    <>
      <PageTitle
        title={`${journal.name}: agent instructions`}
        sub={
          <span>
            Published at{" "}
            <Link href={`/j/${journal.slug}/agent-instructions`} className="underline">
              /j/{journal.slug}/agent-instructions
            </Link>{" "}
            and as .md and llms.txt.
          </span>
        }
      />
      <InstructionsEditor
        journalId={journal.id}
        initial={journal.agentInstructionsTemplateMd ?? DEFAULT_INSTRUCTIONS_TEMPLATE}
        isDefault={!journal.agentInstructionsTemplateMd}
        placeholders={PLACEHOLDERS}
      />
    </>
  );
}
