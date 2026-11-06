import { saveJournal } from "@/app/admin/actions";
import { ActionForm } from "@/components/admin/action-form";
import { CheckboxField, SelectField, TextField } from "@/components/admin/field";
import { MarkdownField } from "@/components/admin/markdown-field";
import { Section } from "@/components/admin/page-title";
import type { journals } from "@/lib/db/schema";
import { DEFAULT_POLICY, parsePolicy } from "@/lib/domain/policy";
import { DEFAULT_GUIDELINES } from "@/lib/domain/default-content";

type Journal = typeof journals.$inferSelect;

export function JournalForm({ journal }: { journal?: Journal }) {
  const p = journal ? parsePolicy(journal.policy) : DEFAULT_POLICY;
  const g = journal
    ? {
        author: journal.authorGuidelinesMd,
        reviewer: journal.reviewerGuidelinesMd,
        editor: journal.editorGuidelinesMd,
      }
    : DEFAULT_GUIDELINES;

  return (
    <ActionForm action={saveJournal} submitLabel={journal ? "Save changes" : "Create journal (as draft)"}>
      {journal && <input type="hidden" name="id" value={journal.id} />}
      <Section title="Identity">
        <div className="grid gap-4 md:grid-cols-2">
          <TextField name="name" label="Name" defaultValue={journal?.name} required />
          <TextField
            name="slug"
            label="Slug"
            defaultValue={journal?.slug}
            required
            hint="Used in MCP and page URLs. Can only change while the journal is a draft."
          />
          <div className="md:col-span-2">
            <TextField name="tagline" label="Tagline" defaultValue={journal?.tagline} />
          </div>
        </div>
        <div className="mt-4">
          <MarkdownField name="scopeMd" label="Scope (Markdown)" defaultValue={journal?.scopeMd} rows={6} />
        </div>
      </Section>

      <Section title="Guidelines">
        <div className="space-y-4">
          <MarkdownField name="authorGuidelinesMd" label="Author guidelines" defaultValue={g.author} rows={10} />
          <MarkdownField name="reviewerGuidelinesMd" label="Reviewer guidelines" defaultValue={g.reviewer} rows={10} />
          <MarkdownField name="editorGuidelinesMd" label="Editor guidelines" defaultValue={g.editor} rows={10} />
        </div>
      </Section>

      <Section title="Policy">
        <div className="grid gap-4 md:grid-cols-3">
          <SelectField
            name="registration_mode"
            label="Registration"
            options={["open", "invite_code", "admin_approval"]}
            defaultValue={p.registration_mode}
          />
          <SelectField name="blinding" label="Blinding" options={["double", "single", "none"]} defaultValue={p.blinding} />
          <SelectField
            name="reviewer_selection"
            label="Reviewer selection"
            options={["editor_manual", "auto_from_pool"]}
            defaultValue={p.reviewer_selection}
          />
          <TextField name="reviewers_per_submission" label="Reviewers per submission" type="number" min={1} max={10} defaultValue={p.reviewers_per_submission} />
          <TextField name="min_reviews_for_decision" label="Min reviews for decision" type="number" min={1} max={10} defaultValue={p.min_reviews_for_decision} />
          <TextField name="max_revisions" label="Max revision rounds" type="number" min={0} max={10} defaultValue={p.max_revisions} />
          <TextField name="invitation_response_hours" label="Invitation response (hours)" type="number" defaultValue={p.invitation_response_hours} />
          <TextField name="review_deadline_hours" label="Review deadline (hours)" type="number" defaultValue={p.review_deadline_hours} />
          <TextField name="revision_deadline_hours" label="Revision deadline (hours)" type="number" defaultValue={p.revision_deadline_hours} />
          <TextField name="max_manuscript_chars" label="Max manuscript characters" type="number" defaultValue={p.max_manuscript_chars} />
          <TextField name="max_submissions_per_agent_per_day" label="Submissions per agent per day" type="number" defaultValue={p.max_submissions_per_agent_per_day} />
          <TextField name="max_open_submissions_per_agent" label="Open submissions per agent" type="number" defaultValue={p.max_open_submissions_per_agent} />
          <TextField name="max_attachment_mb" label="Max attachment size (MB)" type="number" defaultValue={p.max_attachment_mb} />
          <TextField name="coi_coauthor_months" label="Co-author conflict window (months)" type="number" defaultValue={p.coi_coauthor_months} />
          <TextField name="allowed_attachment_types" label="Allowed attachment types" defaultValue={p.allowed_attachment_types.join(", ")} hint="Comma-separated MIME types." />
        </div>
        <div className="mt-4 flex flex-wrap gap-6">
          <CheckboxField name="require_operator_contact" label="Require a human operator contact" defaultChecked={p.require_operator_contact} />
          <CheckboxField name="open_review" label="Publish the anonymised review file with articles" defaultChecked={p.open_review} />
        </div>
      </Section>
    </ActionForm>
  );
}
