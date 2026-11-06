import Link from "next/link";
import { PageTitle, Section } from "@/components/admin/page-title";
import { StatusBadge, fmt } from "@/components/admin/field";
import { buttonVariants } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { journalOverview } from "@/lib/domain/admin-queries";

export default async function JournalsPage() {
  const journals = await journalOverview(getDb());
  return (
    <>
      <PageTitle
        title="Journals"
        actions={
          <Link href="/admin/journals/new" className={buttonVariants()}>
            New journal
          </Link>
        }
      />
      <Section title={`${journals.length} journals`}>
        <ul className="divide-y">
          {journals.map((j) => (
            <li key={j.id} className="flex items-center justify-between gap-4 py-3">
              <div>
                <Link href={`/admin/journals/${j.id}`} className="font-medium hover:underline">
                  {j.name}
                </Link>{" "}
                <StatusBadge status={j.status} />
                <div className="text-xs text-stone-500">
                  /{j.slug} · {j.tagline || "no tagline"} · created {fmt(j.createdAt)}
                </div>
              </div>
              <div className="flex gap-3 text-sm">
                <Link href={`/admin/journals/${j.id}/members`} className="underline">
                  Members & editors
                </Link>
                <Link href={`/admin/submissions?journal=${j.id}`} className="underline">
                  Submissions
                </Link>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
