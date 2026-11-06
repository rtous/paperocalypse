import Link from "next/link";
import { resolveFlagAction } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { PageTitle, Section } from "@/components/admin/page-title";
import { StatusBadge, fmt } from "@/components/admin/field";
import { getDb } from "@/lib/db";
import { journalOverview, stuckItems } from "@/lib/domain/admin-queries";
import { SUBMISSION_STATUSES } from "@/lib/domain/workflow";

export default async function Dashboard() {
  const db = getDb();
  const now = new Date();
  const [journals, stuck] = await Promise.all([journalOverview(db), stuckItems(db, now)]);
  const lists = [
    { title: "Waiting for an editor", rows: stuck.noEditor, when: "since" },
    { title: "Overdue review invitations", rows: stuck.overdueInvitations, when: "respond by" },
    { title: "Overdue reviews", rows: stuck.overdueReviews, when: "due" },
    { title: "Overdue revisions", rows: stuck.overdueRevisions, when: "due" },
  ] as const;

  return (
    <>
      <PageTitle title="Dashboard" sub="Overdue items are expired automatically by the cron tick every 15 minutes." />

      <Section title="Journals" actions={<Link className="text-sm underline" href="/admin/journals/new">New journal</Link>}>
        {journals.length === 0 ? (
          <p className="text-sm text-stone-500">No journals yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500">
                <tr>
                  <th className="py-2 pr-4">Journal</th>
                  <th className="pr-4">Status</th>
                  <th className="pr-4">Members</th>
                  {SUBMISSION_STATUSES.map((s) => (
                    <th key={s} className="pr-3 font-normal">
                      {s.replaceAll("_", " ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {journals.map((j) => (
                  <tr key={j.id} className="border-t">
                    <td className="py-2 pr-4">
                      <Link href={`/admin/journals/${j.id}`} className="font-medium hover:underline">
                        {j.name}
                      </Link>
                      <div className="text-xs text-stone-500">/{j.slug}</div>
                    </td>
                    <td className="pr-4">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="pr-4">
                      {j.activeMembers}
                      {j.pendingMembers > 0 && (
                        <Link href={`/admin/journals/${j.id}/members`} className="ml-1 text-amber-700">
                          (+{j.pendingMembers} pending)
                        </Link>
                      )}
                    </td>
                    {SUBMISSION_STATUSES.map((s) => (
                      <td key={s} className="pr-3 tabular-nums">
                        {j.counts[s] ? (
                          <Link href={`/admin/submissions?journal=${j.id}&status=${s}`} className="hover:underline">
                            {j.counts[s]}
                          </Link>
                        ) : (
                          <span className="text-stone-300">0</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
                      /{r.journalSlug} · {l.when} {fmt(r.since)}
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
                <span className="font-medium">{f.kind}</span> in /{f.journalSlug} · {fmt(f.createdAt)}
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
