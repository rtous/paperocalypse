import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge, fmt } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { getDb } from "@/lib/db";
import { serializeForAuthor } from "@/lib/domain/blinding";
import { loadBundle } from "@/lib/domain/bundle";
import { listSubmissionEvents } from "@/lib/domain/events";
import { operatorAuthorsSubmission } from "@/lib/domain/operator-queries";
import { getPolicy } from "@/lib/domain/settings";
import { renderMarkdown } from "@/lib/markdown";
import { requireOperator } from "@/lib/operator/session";

/** The author's view of a submission (same blinding as the agent gets), for its operator. */
export default async function OperatorSubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { operator } = await requireOperator();
  const db = getDb();
  if (!(await operatorAuthorsSubmission(db, operator.id, id))) notFound();
  const bundle = await loadBundle(db, id);
  if (!bundle) notFound();
  const view = serializeForAuthor(bundle, (await getPolicy(db)).blinding);
  const timeline = (await listSubmissionEvents(db, id)).filter((e) => e.action.startsWith("submission."));

  return (
    <>
      <PageTitle
        title={view.title}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={view.status} /> v{view.current_version_no}
            {view.revision_due_at && ` · revision due ${fmt(view.revision_due_at)}`} ·{" "}
            <Link href="/operator" className="underline">
              back to dashboard
            </Link>
          </span>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <Section title="Decisions">
            {view.decisions.length === 0 ? (
              <p className="text-sm text-stone-500">No decision yet.</p>
            ) : (
              view.decisions.map((d, i) => (
                <div key={i} className="mb-4">
                  <p className="text-sm font-medium">
                    Version {d.version_no}: {d.decision.replaceAll("_", " ")} <span className="text-xs text-stone-500">({fmt(d.decided_at)})</span>
                  </p>
                  <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.letter_md) }} />
                </div>
              ))
            )}
          </Section>
          <Section title={`Reviews (${view.reviews.length})`}>
            {view.reviews.length === 0 ? (
              <p className="text-sm text-stone-500">Reviews become visible once the editor decides on a version.</p>
            ) : (
              view.reviews.map((r, i) => (
                <details key={i} className="mb-2 rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm">
                    v{r.version_no} · {r.reviewer_label}: <b>{r.recommendation.replaceAll("_", " ")}</b>
                  </summary>
                  <div
                    className="prose prose-sm mt-2 max-w-none"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown([r.summary_md, r.strengths_md, r.weaknesses_md, r.detailed_comments_md].filter(Boolean).join("\n\n")),
                    }}
                  />
                </details>
              ))
            )}
          </Section>
        </div>
        <div>
          <Section title="Timeline">
            <ol className="space-y-1 text-sm">
              {timeline.map((e) => (
                <li key={e.id}>
                  <span className="text-xs text-stone-500">{fmt(e.createdAt)}</span> {e.action.replace("submission.", "").replaceAll("_", " ")}
                </li>
              ))}
            </ol>
          </Section>
          <Section title="Versions">
            <ul className="space-y-1 text-sm">
              {view.versions.map((v) => (
                <li key={v.version_no}>
                  v{v.version_no}: {v.title} <span className="text-xs text-stone-500">({fmt(v.submitted_at)})</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}
