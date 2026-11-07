import Link from "next/link";
import { resolveFlagAction } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { PageTitle, Section } from "@/components/admin/page-title";
import { fmt } from "@/components/admin/field";
import { getDb } from "@/lib/db";
import { stuckItems, submissionCounts } from "@/lib/domain/admin-queries";
import { SUBMISSION_STATUSES } from "@/lib/domain/workflow";

export default async function Dashboard() {
  const db = getDb();
  const now = new Date();
  const [counts, stuck] = await Promise.all([submissionCounts(db), stuckItems(db, now)]);
  const lists = [
    { title: "Editorial tasks nobody has taken (48h+)", rows: stuck.unclaimedEditorial, when: "in pool since" },
    { title: "Review tasks nobody has taken (48h+)", rows: stuck.unclaimedReviews, when: "in pool since" },
    { title: "Overdue reviews", rows: stuck.overdueReviews, when: "due" },
    { title: "Overdue revisions", rows: stuck.overdueRevisions, when: "due" },
  ] as const;

  return (
    <>
      <PageTitle title="Dashboard" sub="Overdue items are expired automatically by the cron tick every 15 minutes." />

      <Section title="Submissions by status">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {SUBMISSION_STATUSES.map((s) => (
            <Link key={s} href={`/admin/submissions?status=${s}`} className="hover:underline">
              <span className="text-stone-500">{s.replaceAll("_", " ")}</span>{" "}
              <span className={`tabular-nums ${counts[s] ? "font-semibold" : "text-stone-300"}`}>{counts[s] ?? 0}</span>
            </Link>
          ))}
        </div>
      </Section>

      <div className="grid gap-6 md:grid-cols-2">
        {lists.map((l) => (
          <Section key={l.title} title={`${l.title} (${l.rows.length})`}>
            {l.rows.length === 0 ? (
              <p className="text-sm text-stone-500">Nothing here.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {l.rows.map((r, i) => (
                  <li key={`${r.submissionId}-${i}`}>
                    <Link href={`/admin/submissions/${r.submissionId}`} className="font-medium hover:underline">
                      {r.title}
                    </Link>
                    <div className="text-xs text-stone-500">
                      {l.when} {fmt(r.since)}
                      {"reviewer" in r && r.reviewer ? ` · ${r.reviewer}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ))}
      </div>

      <Section title={`Open flags (${stuck.openFlags.length})`}>
        {stuck.openFlags.length === 0 ? (
          <p className="text-sm text-stone-500">No flags raised.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {stuck.openFlags.map((f) => (
              <li key={f.id}>
                <span className="font-medium">{f.kind}</span> · {fmt(f.createdAt)}
                {f.submissionId && (
                  <Link href={`/admin/submissions/${f.submissionId}`} className="ml-2 underline">
                    submission
                  </Link>
                )}
                <p className="whitespace-pre-wrap text-xs text-stone-600">{f.reasonMd.slice(0, 600)}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {(["resolved", "dismissed"] as const).map((st) => (
                    <ActionForm key={st} action={resolveFlagAction} submitLabel={st === "resolved" ? "Resolve" : "Dismiss"} variant="outline" className="flex items-center gap-2">
                      <input type="hidden" name="flagId" value={f.id} />
                      <input type="hidden" name="status" value={st} />
                      {st === "resolved" && <input name="note" placeholder="note (optional)" className="h-7 rounded border px-2 text-xs" />}
                    </ActionForm>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
