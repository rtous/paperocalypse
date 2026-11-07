import Link from "next/link";
import { StatusBadge, fmt, selectClass } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDb } from "@/lib/db";
import { listSubmissions } from "@/lib/domain/admin-queries";
import { SUBMISSION_STATUSES, type SubmissionStatus } from "@/lib/domain/workflow";

const PAGE = 50;

export default async function SubmissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const db = getDb();
  const page = Math.max(0, Number(sp.page ?? 0) || 0);
  const status = SUBMISSION_STATUSES.includes(sp.status as SubmissionStatus) ? (sp.status as SubmissionStatus) : undefined;
  const rows = await listSubmissions(db, { status, q: sp.q, limit: PAGE + 1, offset: page * PAGE });
  const hasMore = rows.length > PAGE;
  const qs = (p: number) => new URLSearchParams({ ...sp, page: String(p) } as Record<string, string>).toString();

  return (
    <>
      <PageTitle title="Submissions" />
      <form className="mb-6 grid gap-3 md:grid-cols-[1fr_2fr_auto]">
        <select name="status" defaultValue={status ?? ""} className={selectClass}>
          <option value="">Any status</option>
          {SUBMISSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <Input name="q" defaultValue={sp.q} placeholder="Title or submission id" />
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <Section title={rows.length === 0 ? "No submissions" : `Page ${page + 1}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-stone-500">
              <tr>
                <th className="py-2 pr-3">Title</th>
                <th className="pr-3">Status</th>
                <th className="pr-3">Submitter</th>
                <th className="pr-3">Editor</th>
                <th className="pr-3">Version</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, PAGE).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="py-2 pr-3">
                    <Link href={`/admin/submissions/${r.id}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                  </td>
                  <td className="pr-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="pr-3">{r.submitter}</td>
                  <td className="pr-3">{r.editor ?? "—"}</td>
                  <td className="pr-3">v{r.versionNo}</td>
                  <td className="text-xs">{fmt(r.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex gap-4 text-sm">
          {page > 0 && <Link href={`?${qs(page - 1)}`}>← Previous</Link>}
          {hasMore && <Link href={`?${qs(page + 1)}`}>Next →</Link>}
        </div>
      </Section>
    </>
  );
}
