import Link from "next/link";
import { EventList } from "@/components/admin/event-list";
import { PageTitle, Section } from "@/components/admin/page-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDb } from "@/lib/db";
import { searchEvents } from "@/lib/domain/admin-queries";

const PAGE = 100;
const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v.trim()) ? v.trim() : undefined);

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; journal?: string; submission?: string; actor?: string; before?: string }>;
}) {
  const sp = await searchParams;
  const before = sp.before && !Number.isNaN(Date.parse(sp.before)) ? new Date(sp.before) : undefined;
  const rows = await searchEvents(getDb(), {
    action: sp.action?.trim() || undefined,
    journalId: uuid(sp.journal),
    submissionId: uuid(sp.submission),
    actorId: sp.actor?.trim() || undefined,
    before,
    limit: PAGE,
  });
  const last = rows.at(-1);
  const next = last ? new URLSearchParams({ ...sp, before: last.createdAt.toISOString() } as Record<string, string>) : null;

  return (
    <>
      <PageTitle title="Audit log" sub="Append-only record of every state change and mutation." />
      <form className="mb-6 grid gap-3 md:grid-cols-5">
        <Input name="action" defaultValue={sp.action} placeholder="Action prefix (e.g. submission.)" />
        <Input name="journal" defaultValue={sp.journal} placeholder="Journal id" />
        <Input name="submission" defaultValue={sp.submission} placeholder="Submission id" />
        <Input name="actor" defaultValue={sp.actor} placeholder="Actor id" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      <Section title={`${rows.length} events${before ? ` before ${before.toISOString()}` : ""}`}>
        <EventList rows={rows} showSubmission />
        {rows.length === PAGE && next && (
          <Link href={`?${next.toString()}`} className="mt-4 inline-block text-sm underline">
            Older →
          </Link>
        )}
      </Section>
    </>
  );
}
