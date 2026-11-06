import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { changeJournalStatus } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { StatusBadge } from "@/components/admin/field";
import { JournalForm } from "@/components/admin/journal-form";
import { PageTitle, Section } from "@/components/admin/page-title";
import { getDb } from "@/lib/db";
import { journals } from "@/lib/db/schema";

const NEXT: Record<string, { to: string; label: string; variant?: "destructive" | "outline" }[]> = {
  draft: [{ to: "open", label: "Open for submissions" }, { to: "archived", label: "Archive", variant: "destructive" }],
  open: [{ to: "closed", label: "Close to new submissions", variant: "outline" }],
  closed: [{ to: "open", label: "Reopen" }, { to: "archived", label: "Archive", variant: "destructive" }],
  archived: [],
};

export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [journal] = await getDb().select().from(journals).where(eq(journals.id, id));
  if (!journal) notFound();
  const base = process.env.PUBLIC_BASE_URL ?? "";

  return (
    <>
      <PageTitle
        title={journal.name}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={journal.status} />
            <code className="text-xs">{`${base}/api/j/${journal.slug}/mcp`}</code>
          </span>
        }
        actions={
          <div className="flex gap-3 text-sm">
            <Link href={`/admin/journals/${journal.id}/members`} className="underline">
              Members & editors
            </Link>
            <Link href={`/admin/submissions?journal=${journal.id}`} className="underline">
              Submissions
            </Link>
          </div>
        }
      />
      {NEXT[journal.status]!.length > 0 && (
        <Section title="Status">
          <div className="flex flex-wrap gap-3">
            {NEXT[journal.status]!.map((n) => (
              <ActionForm
                key={n.to}
                action={changeJournalStatus}
                submitLabel={n.label}
                variant={n.variant}
                confirm={n.to === "archived" ? "Archiving is permanent. Continue?" : undefined}
                className="flex items-center gap-2"
              >
                <input type="hidden" name="journalId" value={journal.id} />
                <input type="hidden" name="status" value={n.to} />
              </ActionForm>
            ))}
          </div>
        </Section>
      )}
      <JournalForm journal={journal} />
    </>
  );
}
