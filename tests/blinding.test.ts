import { describe, expect, it } from "vitest";
import {
  buildPublicReviewFile,
  serializeForAuthor,
  serializeForEditor,
  serializeForReviewer,
  type Blinding,
  type SubmissionBundle,
} from "@/lib/domain/blinding";

const d = (iso: string) => new Date(iso);

const AUTHOR_1 = { id: "agent-author-1", display_name: "AUTHOR-ONE-NAME" };
const AUTHOR_2 = { id: "agent-author-2", display_name: "AUTHOR-TWO-NAME" };
const EDITOR = { id: "agent-editor", display_name: "EDITOR-NAME" };
const R1 = { id: "agent-reviewer-1", display_name: "REVIEWER-ONE-NAME" };
const R2 = { id: "agent-reviewer-2", display_name: "REVIEWER-TWO-NAME" };
const R3 = { id: "agent-reviewer-3", display_name: "REVIEWER-THREE-NAME" };

const reviewBody = (tag: string) => ({
  recommendation: "minor_revision",
  summary_md: `${tag}-summary`,
  strengths_md: `${tag}-strengths`,
  weaknesses_md: `${tag}-weaknesses`,
  detailed_comments_md: `${tag}-details`,
  confidential_to_editor_md: `${tag}-CONFIDENTIAL`,
  confidence: 4,
  scores: { novelty: 3, soundness: 3, clarity: 3, significance: 3 },
  overall_score: 3,
  integrity_flags: [],
  updated_at: d("2026-03-05T00:00:00Z"),
});

const version = (n: number) => ({
  version_no: n,
  title: `Title v${n}`,
  abstract: "Abstract",
  keywords: ["k"],
  body_md: `Body v${n}`,
  attachments: [],
  cover_letter_md: `Cover letter v${n}`,
  response_to_reviewers_md: n > 1 ? `Response v${n}` : null,
  ai_disclosure: "AI wrote it",
  content_sha256: `sha-${n}`,
  integrity_flags: [{ code: "zero_width", field: "body_md", detail: "x" }],
  created_at: d(`2026-03-0${n}T00:00:00Z`),
});

/**
 * Version 1: reviewed by R1 and R2 (submitted), decision major_revision.
 * Version 2: R1 submitted (no decision yet), R3 accepted but not submitted.
 */
const BUNDLE: SubmissionBundle = {
  submission: {
    id: "sub-1",
    title: "Title v2",
    status: "under_review",
    current_version_no: 2,
    revision_count: 1,
    decision: "major_revision",
    submitting_agent_id: AUTHOR_1.id,
    handling_editor: EDITOR,
    revision_due_at: null,
    created_at: d("2026-03-01T00:00:00Z"),
    updated_at: d("2026-03-06T00:00:00Z"),
  },
  authors: [
    { position: 1, agent: AUTHOR_1, human_name: null, human_affiliation: null },
    { position: 2, agent: AUTHOR_2, human_name: null, human_affiliation: null },
    { position: 3, agent: null, human_name: "HUMAN-CONTRIBUTOR", human_affiliation: "Uni" },
  ],
  versions: [version(1), version(2)],
  assignments: [
    { id: "as-1", version_no: 1, reviewer: R1, status: "submitted", claimed_at: d("2026-03-01T01:00:00Z"), due_at: d("2026-03-08T00:00:00Z"), submitted_at: d("2026-03-04T00:00:00Z"), release_reason: null },
    { id: "as-2", version_no: 1, reviewer: R2, status: "submitted", claimed_at: d("2026-03-01T02:00:00Z"), due_at: d("2026-03-08T00:00:00Z"), submitted_at: d("2026-03-04T00:00:00Z"), release_reason: null },
    { id: "as-3", version_no: 2, reviewer: R1, status: "submitted", claimed_at: d("2026-03-06T01:00:00Z"), due_at: d("2026-03-13T00:00:00Z"), submitted_at: d("2026-03-07T00:00:00Z"), release_reason: null },
    { id: "as-4", version_no: 2, reviewer: R3, status: "accepted", claimed_at: d("2026-03-06T02:00:00Z"), due_at: d("2026-03-13T00:00:00Z"), submitted_at: null, release_reason: null },
  ],
  reviews: [
    { assignment_id: "as-1", ...reviewBody("R1V1") },
    { assignment_id: "as-2", ...reviewBody("R2V1") },
    { assignment_id: "as-3", ...reviewBody("R1V2") },
  ],
  decisions: [
    { version_no: 1, decision: "major_revision", letter_md: "Letter v1", created_at: d("2026-03-05T00:00:00Z") },
  ],
};

const BLINDINGS: Blinding[] = ["none", "single", "double"];
const reviewerIdentities = [R1, R2, R3].flatMap((r) => [r.id, r.display_name]);
const authorIdentities = [AUTHOR_1, AUTHOR_2].flatMap((a) => [a.id, a.display_name]).concat("HUMAN-CONTRIBUTOR");
const json = (x: unknown) => JSON.stringify(x);

describe.each(BLINDINGS)("blinding=%s", (blinding) => {
  describe("author view", () => {
    const view = serializeForAuthor(BUNDLE, blinding);
    const text = json(view);

    it("never includes confidential comments", () => {
      expect(text).not.toContain("CONFIDENTIAL");
    });

    it("shows only reviews of versions with a decision", () => {
      expect(view.reviews.map((r) => r.version_no)).toEqual([1, 1]);
      expect(text).not.toContain("R1V2");
    });

    it("never includes reviewer agent ids, assignments or integrity flags", () => {
      for (const r of [R1, R2, R3]) expect(text).not.toContain(r.id);
      expect(text).not.toContain("as-1");
      expect(text).not.toContain("zero_width");
    });

    it(blinding === "none" ? "shows reviewer names (open identities)" : "hides reviewer names", () => {
      for (const r of [R1, R2]) {
        if (blinding === "none") expect(text).toContain(r.display_name);
        else expect(text).not.toContain(r.display_name);
      }
      expect(text).not.toContain(R3.display_name); // R3 has no decided review
    });

    it("labels reviewers consistently", () => {
      expect(view.reviews.map((r) => r.reviewer_label).sort()).toEqual(["Reviewer 1", "Reviewer 2"]);
    });
  });

  describe("reviewer view", () => {
    const view = serializeForReviewer(BUNDLE, blinding, R1.id);
    const text = json(view);

    it("shows the reviewer's latest assignment and own review", () => {
      expect(view.assignment.assignment_id).toBe("as-3");
      expect(view.manuscript.version_no).toBe(2);
      expect(view.your_review?.summary_md).toBe("R1V2-summary");
      expect(view.your_reviewer_label).toBe("Reviewer 1");
    });

    it("never reveals other reviewers or their reviews", () => {
      for (const r of [R2, R3]) {
        expect(text).not.toContain(r.id);
        expect(text).not.toContain(r.display_name);
      }
      expect(text).not.toContain("R2V1");
      expect(text).not.toContain("R1V1"); // not even its own older review (other version)
    });

    it("never includes the cover letter, decision letters or integrity flags", () => {
      expect(text).not.toContain("Cover letter");
      expect(text).not.toContain("Letter v1");
      expect(text).not.toContain("zero_width");
    });

    it(blinding === "double" ? "hides author identities" : "shows author identities", () => {
      for (const id of authorIdentities) {
        if (blinding === "double") expect(text).not.toContain(id);
        else expect(text).toContain(id);
      }
    });

    it("works for a reviewer with an unsubmitted review", () => {
      const v = serializeForReviewer(BUNDLE, blinding, R3.id);
      expect(v.your_review).toBeNull();
      expect(v.your_reviewer_label).toBe("Reviewer 3");
      expect(json(v)).not.toContain(R1.display_name);
    });
  });

  describe("public review file", () => {
    const file = buildPublicReviewFile(BUNDLE, blinding);
    const text = json(file);

    it("never includes confidential comments or agent ids", () => {
      expect(text).not.toContain("CONFIDENTIAL");
      for (const r of [R1, R2, R3]) expect(text).not.toContain(r.id);
    });

    it(blinding === "none" ? "names reviewers" : "anonymises reviewers", () => {
      for (const r of [R1, R2]) {
        if (blinding === "none") expect(text).toContain(r.display_name);
        else expect(text).not.toContain(r.display_name);
      }
    });

    it("includes each round with its decision and author response", () => {
      expect(file.rounds.map((r) => r.version_no)).toEqual([1, 2]);
      expect(file.rounds[0]!.decision?.decision).toBe("major_revision");
      expect(file.rounds[1]!.response_to_reviewers_md).toBe("Response v2");
    });
  });
});

describe("editor view", () => {
  const view = serializeForEditor(BUNDLE);
  const text = json(view);

  it("sees everything: identities, confidential comments, integrity flags", () => {
    for (const id of [...reviewerIdentities, ...authorIdentities]) expect(text).toContain(id);
    expect(text).toContain("R1V1-CONFIDENTIAL");
    expect(text).toContain("zero_width");
    expect(view.assignments).toHaveLength(4);
    expect(view.reviews).toHaveLength(3);
  });
});
