import { asc, eq, inArray } from "drizzle-orm";
import {
  agents,
  decisions,
  reviewAssignments,
  reviews,
  submissionAuthors,
  submissionVersions,
  submissions,
} from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { AgentRef, SubmissionBundle } from "./blinding";

/** Load everything the serializers need about one submission. Returns null if missing. */
export async function loadBundle(db: Db, submissionId: string): Promise<SubmissionBundle | null> {
  const [s] = await db.select().from(submissions).where(eq(submissions.id, submissionId));
  if (!s) return null;

  const [authorRows, versionRows, assignmentRows, decisionRows] = await Promise.all([
    db
      .select()
      .from(submissionAuthors)
      .where(eq(submissionAuthors.submissionId, submissionId))
      .orderBy(asc(submissionAuthors.position)),
    db
      .select()
      .from(submissionVersions)
      .where(eq(submissionVersions.submissionId, submissionId))
      .orderBy(asc(submissionVersions.versionNo)),
    db
      .select()
      .from(reviewAssignments)
      .where(eq(reviewAssignments.submissionId, submissionId))
      .orderBy(asc(reviewAssignments.claimedAt)),
    db
      .select()
      .from(decisions)
      .where(eq(decisions.submissionId, submissionId))
      .orderBy(asc(decisions.createdAt)),
  ]);

  const reviewRows = assignmentRows.length
    ? await db
        .select()
        .from(reviews)
        .where(
          inArray(
            reviews.assignmentId,
            assignmentRows.map((a) => a.id),
          ),
        )
    : [];

  const agentIds = [
    ...new Set(
      [
        s.handlingEditorId,
        ...authorRows.map((a) => a.agentId),
        ...assignmentRows.map((a) => a.reviewerAgentId),
      ].filter((x): x is string => !!x),
    ),
  ];
  const agentRows = agentIds.length
    ? await db
        .select({ id: agents.id, display_name: agents.displayName })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const agentMap = new Map<string, AgentRef>(agentRows.map((a) => [a.id, a]));
  const ref = (id: string): AgentRef => agentMap.get(id) ?? { id, display_name: "(unknown agent)" };

  return {
    submission: {
      id: s.id,
      journal_id: s.journalId,
      title: s.title,
      status: s.status,
      current_version_no: s.currentVersionNo,
      revision_count: s.revisionCount,
      decision: s.decision,
      submitting_agent_id: s.submittingAgentId,
      handling_editor: s.handlingEditorId ? ref(s.handlingEditorId) : null,
      revision_due_at: s.revisionDueAt,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
    },
    authors: authorRows.map((a) => ({
      position: a.position,
      agent: a.agentId ? ref(a.agentId) : null,
      human_name: a.humanName,
      human_affiliation: a.humanAffiliation,
    })),
    versions: versionRows.map((v) => ({
      version_no: v.versionNo,
      title: v.title,
      abstract: v.abstract,
      keywords: v.keywords,
      body_md: v.bodyMd,
      attachments: v.attachments,
      cover_letter_md: v.coverLetterMd,
      response_to_reviewers_md: v.responseToReviewersMd,
      ai_disclosure: v.aiDisclosure,
      content_sha256: v.contentSha256,
      integrity_flags: v.integrityFlags,
      created_at: v.createdAt,
    })),
    assignments: assignmentRows.map((a) => ({
      id: a.id,
      version_no: a.versionNo,
      reviewer: ref(a.reviewerAgentId),
      status: a.status,
      claimed_at: a.claimedAt,
      due_at: a.dueAt,
      submitted_at: a.submittedAt,
      release_reason: a.releaseReason,
    })),
    reviews: reviewRows.map((r) => ({
      assignment_id: r.assignmentId,
      recommendation: r.recommendation,
      summary_md: r.summaryMd,
      strengths_md: r.strengthsMd,
      weaknesses_md: r.weaknessesMd,
      detailed_comments_md: r.detailedCommentsMd,
      confidential_to_editor_md: r.confidentialToEditorMd,
      confidence: r.confidence,
      scores: r.scores,
      overall_score: r.overallScore,
      integrity_flags: r.integrityFlags,
      updated_at: r.updatedAt,
    })),
    decisions: decisionRows.map((d) => ({
      version_no: d.versionNo,
      decision: d.decision,
      letter_md: d.letterMd,
      created_at: d.createdAt,
    })),
  };
}
