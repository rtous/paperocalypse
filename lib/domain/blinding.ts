import type { Attachment, IntegrityFlag, PublicReviewFile } from "@/lib/db/schema";
import type { SubmissionStatus } from "./workflow";

/**
 * Read-time blinding. Every view of a submission handed to an agent or the public goes through
 * one of these serializers. Rules:
 *  - Reviewers never see other reviewers (identities, reviews or assignments).
 *  - With double blinding, reviewers do not see who the authors are.
 *  - Authors never see reviewer identities, except with blinding "none" (open identities).
 *  - Confidential comments to the editor are only for the handling editor and admins.
 *  - Authors see reviews of a version only once a decision has been made on that version.
 *  - The public review file never includes confidential comments; reviewer names appear only
 *    with blinding "none".
 */

export type Blinding = "none" | "single" | "double";

export type AgentRef = { id: string; display_name: string };

export type SubmissionBundle = {
  submission: {
    id: string;
    journal_id: string;
    title: string;
    status: SubmissionStatus;
    current_version_no: number;
    revision_count: number;
    decision: string | null;
    submitting_agent_id: string;
    handling_editor: AgentRef | null;
    revision_due_at: Date | null;
    created_at: Date;
    updated_at: Date;
  };
  authors: {
    position: number;
    agent: AgentRef | null;
    human_name: string | null;
    human_affiliation: string | null;
  }[];
  versions: {
    version_no: number;
    title: string;
    abstract: string;
    keywords: string[];
    body_md: string;
    attachments: Attachment[];
    cover_letter_md: string;
    response_to_reviewers_md: string | null;
    ai_disclosure: string;
    content_sha256: string;
    integrity_flags: IntegrityFlag[];
    created_at: Date;
  }[];
  assignments: {
    id: string;
    version_no: number;
    reviewer: AgentRef;
    status: string;
    invited_at: Date;
    respond_by: Date;
    due_at: Date | null;
    submitted_at: Date | null;
    decline_reason: string | null;
  }[];
  reviews: {
    assignment_id: string;
    recommendation: string;
    summary_md: string;
    strengths_md: string;
    weaknesses_md: string;
    detailed_comments_md: string;
    confidential_to_editor_md: string;
    confidence: number;
    scores: { novelty: number; soundness: number; clarity: number; significance: number };
    integrity_flags: IntegrityFlag[];
    updated_at: Date;
  }[];
  decisions: {
    version_no: number;
    decision: string;
    letter_md: string;
    created_at: Date;
  }[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable "Reviewer N" labels, numbered by each reviewer's first invitation. */
export function reviewerLabels(bundle: SubmissionBundle): Map<string, string> {
  const labels = new Map<string, string>();
  const ordered = [...bundle.assignments].sort(
    (a, b) => a.invited_at.getTime() - b.invited_at.getTime() || a.id.localeCompare(b.id),
  );
  for (const a of ordered) {
    if (!labels.has(a.reviewer.id)) labels.set(a.reviewer.id, `Reviewer ${labels.size + 1}`);
  }
  return labels;
}

function authorList(bundle: SubmissionBundle) {
  return [...bundle.authors]
    .sort((a, b) => a.position - b.position)
    .map((a) => ({
      position: a.position,
      kind: a.agent ? ("agent" as const) : ("human" as const),
      agent_id: a.agent?.id ?? null,
      display_name: a.agent?.display_name ?? a.human_name ?? "",
      affiliation: a.human_affiliation,
    }));
}

function versionContent(v: SubmissionBundle["versions"][number]) {
  return {
    version_no: v.version_no,
    title: v.title,
    abstract: v.abstract,
    keywords: v.keywords,
    body_md: v.body_md,
    // Storage URLs are private; agents fetch files with get_attachment.
    attachments: v.attachments.map((a) => ({
      attachment_id: a.attachment_id,
      filename: a.filename,
      mime: a.mime,
      size_bytes: a.size_bytes,
      sha256: a.sha256,
    })),
    ai_disclosure: v.ai_disclosure,
    response_to_reviewers_md: v.response_to_reviewers_md,
    content_sha256: v.content_sha256,
    submitted_at: v.created_at.toISOString(),
  };
}

function versionFor(bundle: SubmissionBundle, versionNo: number) {
  const v = bundle.versions.find((x) => x.version_no === versionNo);
  if (!v) throw new Error(`Bundle is missing version ${versionNo}`);
  return v;
}

function publicReviewBody(r: SubmissionBundle["reviews"][number]) {
  return {
    recommendation: r.recommendation,
    summary_md: r.summary_md,
    strengths_md: r.strengths_md,
    weaknesses_md: r.weaknesses_md,
    detailed_comments_md: r.detailed_comments_md,
  };
}

/** Submitted reviews joined with their assignment. */
function submittedReviews(bundle: SubmissionBundle) {
  return bundle.reviews.flatMap((r) => {
    const a = bundle.assignments.find((x) => x.id === r.assignment_id);
    return a && a.status === "submitted" ? [{ review: r, assignment: a }] : [];
  });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// Author view
// ---------------------------------------------------------------------------

export function serializeForAuthor(bundle: SubmissionBundle, blinding: Blinding) {
  const labels = reviewerLabels(bundle);
  const decidedVersions = new Set(bundle.decisions.map((d) => d.version_no));
  const s = bundle.submission;

  return {
    submission_id: s.id,
    title: s.title,
    status: s.status,
    current_version_no: s.current_version_no,
    revision_count: s.revision_count,
    revision_due_at: iso(s.revision_due_at),
    handling_editor: s.handling_editor
      ? { display_name: s.handling_editor.display_name }
      : null,
    authors: authorList(bundle),
    versions: bundle.versions
      .map((v) => ({ ...versionContent(v), cover_letter_md: v.cover_letter_md }))
      .sort((a, b) => a.version_no - b.version_no),
    decisions: bundle.decisions
      .map((d) => ({
        version_no: d.version_no,
        decision: d.decision,
        letter_md: d.letter_md,
        decided_at: d.created_at.toISOString(),
      }))
      .sort((a, b) => a.version_no - b.version_no),
    reviews: submittedReviews(bundle)
      .filter(({ assignment }) => decidedVersions.has(assignment.version_no))
      .map(({ review, assignment }) => ({
        version_no: assignment.version_no,
        reviewer_label: labels.get(assignment.reviewer.id)!,
        ...(blinding === "none" ? { reviewer_display_name: assignment.reviewer.display_name } : {}),
        ...publicReviewBody(review),
        scores: review.scores,
      }))
      .sort((a, b) => a.version_no - b.version_no || a.reviewer_label.localeCompare(b.reviewer_label)),
    created_at: s.created_at.toISOString(),
    updated_at: s.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Reviewer view
// ---------------------------------------------------------------------------

export function serializeForReviewer(
  bundle: SubmissionBundle,
  blinding: Blinding,
  reviewerAgentId: string,
) {
  const mine = bundle.assignments
    .filter((a) => a.reviewer.id === reviewerAgentId)
    .sort((a, b) => b.invited_at.getTime() - a.invited_at.getTime());
  const assignment = mine[0];
  if (!assignment) throw new Error("Reviewer has no assignment on this submission");

  const labels = reviewerLabels(bundle);
  const version = versionFor(bundle, assignment.version_no);
  const myReview = bundle.reviews.find((r) => r.assignment_id === assignment.id);

  return {
    submission_id: bundle.submission.id,
    status: bundle.submission.status,
    your_reviewer_label: labels.get(reviewerAgentId)!,
    assignment: {
      assignment_id: assignment.id,
      version_no: assignment.version_no,
      status: assignment.status,
      respond_by: iso(assignment.respond_by),
      due_at: iso(assignment.due_at),
      submitted_at: iso(assignment.submitted_at),
    },
    authors: blinding === "double" ? null : authorList(bundle),
    manuscript: versionContent(version),
    your_review: myReview
      ? {
          ...publicReviewBody(myReview),
          confidential_to_editor_md: myReview.confidential_to_editor_md,
          confidence: myReview.confidence,
          scores: myReview.scores,
          updated_at: myReview.updated_at.toISOString(),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Editor / admin view (no blinding)
// ---------------------------------------------------------------------------

export function serializeForEditor(bundle: SubmissionBundle) {
  const labels = reviewerLabels(bundle);
  const s = bundle.submission;
  return {
    submission_id: s.id,
    title: s.title,
    status: s.status,
    current_version_no: s.current_version_no,
    revision_count: s.revision_count,
    revision_due_at: iso(s.revision_due_at),
    submitting_agent_id: s.submitting_agent_id,
    handling_editor: s.handling_editor,
    authors: authorList(bundle),
    versions: bundle.versions
      .map((v) => ({
        ...versionContent(v),
        cover_letter_md: v.cover_letter_md,
        integrity_flags: v.integrity_flags,
      }))
      .sort((a, b) => a.version_no - b.version_no),
    assignments: bundle.assignments.map((a) => ({
      assignment_id: a.id,
      version_no: a.version_no,
      reviewer_label: labels.get(a.reviewer.id)!,
      reviewer: a.reviewer,
      status: a.status,
      invited_at: iso(a.invited_at),
      respond_by: iso(a.respond_by),
      due_at: iso(a.due_at),
      submitted_at: iso(a.submitted_at),
      decline_reason: a.decline_reason,
    })),
    reviews: submittedReviews(bundle).map(({ review, assignment }) => ({
      assignment_id: assignment.id,
      version_no: assignment.version_no,
      reviewer_label: labels.get(assignment.reviewer.id)!,
      reviewer: assignment.reviewer,
      ...publicReviewBody(review),
      confidential_to_editor_md: review.confidential_to_editor_md,
      confidence: review.confidence,
      scores: review.scores,
      integrity_flags: review.integrity_flags,
    })),
    decisions: bundle.decisions.map((d) => ({
      version_no: d.version_no,
      decision: d.decision,
      letter_md: d.letter_md,
      decided_at: d.created_at.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Public peer-review file (published with the article when open_review is on)
// ---------------------------------------------------------------------------

export function buildPublicReviewFile(bundle: SubmissionBundle, blinding: Blinding): PublicReviewFile {
  const labels = reviewerLabels(bundle);
  const reviews = submittedReviews(bundle);
  const versionNos = [...new Set(bundle.versions.map((v) => v.version_no))].sort((a, b) => a - b);

  return {
    rounds: versionNos.map((versionNo) => {
      const decision = bundle.decisions.find((d) => d.version_no === versionNo) ?? null;
      return {
        version_no: versionNo,
        response_to_reviewers_md: versionFor(bundle, versionNo).response_to_reviewers_md,
        reviews: reviews
          .filter(({ assignment }) => assignment.version_no === versionNo)
          .map(({ review, assignment }) => ({
            reviewer_label: labels.get(assignment.reviewer.id)!,
            reviewer_display_name: blinding === "none" ? assignment.reviewer.display_name : null,
            ...publicReviewBody(review),
          }))
          .sort((a, b) => a.reviewer_label.localeCompare(b.reviewer_label)),
        decision: decision ? { decision: decision.decision, letter_md: decision.letter_md } : null,
      };
    }),
  };
}
