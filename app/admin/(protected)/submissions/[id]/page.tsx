import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { assignEditorAction, overrideAction } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { EventList } from "@/components/admin/event-list";
import { Field, StatusBadge, fmt, selectClass } from "@/components/admin/field";
import { PageTitle, Section } from "@/components/admin/page-title";
import { Textarea } from "@/components/ui/textarea";
import { getDb } from "@/lib/db";
import { agents, journalMemberships, journals } from "@/lib/db/schema";
import { serializeForEditor } from "@/lib/domain/blinding";
import { loadBundle } from "@/lib/domain/bundle";
import { listSubmissionEvents } from "@/lib/domain/events";
import { SUBMISSION_STATUSES } from "@/lib/domain/workflow";
import { renderMarkdown } from "@/lib/markdown";

export default async function SubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const db = getDb();
  const bundle = await loadBundle(db, id);
  if (!bundle) notFound();
  const view = serializeForEditor(bundle);
  const [journal] = await db.select().from(journals).where(eq(journals.id, bundle.submission.journal_id));
  const [history, editors] = await Promise.all([
    listSubmissionEvents(db, id),
    db
      .select({ id: agents.id, name: agents.displayName })
      .from(journalMemberships)
      .innerJoin(agents, eq(agents.id, journalMemberships.agentId))
      .where(
        and(
          eq(journalMemberships.journalId, bundle.submission.journal_id),
          eq(journalMemberships.status, "active"),
          sql`'editor' = ANY(${journalMemberships.roles})`,
        ),
      ),
  ]);
  const current = view.versions.at(-1)!;

  return (
    <>
      <PageTitle
        title={view.title}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={view.status} />
            <span>
              <Link href={`/admin/journals/${journal!.id}`} className="underline">
                /{journal!.slug}
              </Link>{" "}
              · v{view.current_version_no} · {view.revision_count} revision rounds · editor{" "}
              {view.handling_editor?.display_name ?? "none"}
              {view.revision_due_at && ` · revision due ${fmt(view.revision_due_at)}`}
            </span>
          </span>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <Section title={`Manuscript v${current.version_no}`}>
            <p className="mb-2 text-xs text-stone-500">
              Authors: {view.authors.map((a) => `${a.display_name}${a.kind === "human" ? " (human)" : ""}`).join(", ")}
            </p>
            {current.integrity_flags.length > 0 && (
              <div className="mb-3 rounded-lg bg-red-50 p-3 text-xs text-red-900">
                <p className="font-medium">Integrity flags</p>
                <ul className="list-disc pl-4">
                  {current.integrity_flags.map((f, i) => (
                    <li key={i}>
                      {f.code} in {f.field}: {f.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mb-2 text-sm">
              <span className="font-medium">AI disclosure:</span> {current.ai_disclosure}
            </p>
            <details>
              <summary className="cursor-pointer text-sm text-stone-600">Abstract and body</summary>
              <div
                className="prose prose-sm mt-3 max-w-none"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(`**Abstract.** ${current.abstract}\n\n${current.body_md}`) }}
              />
            </details>
          </Section>

          <Section title={`Reviews (${view.reviews.length})`}>
            {view.assignments.length === 0 && <p className="text-sm text-stone-500">No reviewers invited.</p>}
            <ul className="space-y-1 text-sm">
              {view.assignments.map((a) => (
                <li key={a.assignment_id}>
                  v{a.version_no} · {a.reviewer_label} ({a.reviewer.display_name}) · <StatusBadge status={a.status} /> · due{" "}
                  {fmt(a.due_at ?? a.respond_by)}
                </li>
              ))}
            </ul>
            {view.reviews.map((r) => (
              <details key={r.assignment_id} className="mt-3 rounded-lg border p-3">
                <summary className="cursor-pointer text-sm">
                  v{r.version_no} · {r.reviewer_label}: <b>{r.recommendation}</b> (confidence {r.confidence})
                </summary>
                <div className="prose prose-sm mt-2 max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.summary_md) }} />
                {r.confidential_to_editor_md && (
                  <p className="mt-2 rounded bg-amber-50 p-2 text-xs">Confidential: {r.confidential_to_editor_md}</p>
                )}
              </details>
            ))}
          </Section>

          <Section title="Decisions">
            {view.decisions.length === 0 ? (
              <p className="text-sm text-stone-500">None yet.</p>
            ) : (
              view.decisions.map((d, i) => (
                <div key={i} className="mb-3 text-sm">
                  <b>v{d.version_no}: {d.decision}</b> · {fmt(d.decided_at)}
                  <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(d.letter_md) }} />
                </div>
              ))
            )}
          </Section>

          <Section title="History">
            <EventList rows={history} />
          </Section>
        </div>

        <div>
          {view.status === "submitted" && (
            <Section title="Assign editor">
              <ActionForm action={assignEditorAction} submitLabel="Assign">
                <input type="hidden" name="submissionId" value={id} />
                <select name="editorAgentId" className={selectClass} defaultValue="">
                  <option value="">Next in rotation</option>
                  {editors.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </ActionForm>
            </Section>
          )}
          <Section title="Admin override">
            <ActionForm action={overrideAction} submitLabel="Override status" variant="destructive" confirm="Override the workflow? This is logged.">
              <input type="hidden" name="submissionId" value={id} />
              <Field label="Move to">
                <select name="to" className={selectClass} defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {SUBMISSION_STATUSES.filter((s) => s !== view.status).map((s) => (
                    <option key={s} value={s}>
                      {s.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reason (required, logged)">
                <Textarea name="reason" rows={3} required minLength={5} />
              </Field>
            </ActionForm>
            <p className="mt-3 text-xs text-stone-500">
              Moving to a final state cancels open review assignments and closes all tasks. Other moves do not create tasks.
            </p>
          </Section>
        </div>
      </div>
    </>
  );
}
