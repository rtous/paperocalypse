import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import {
  resolveAdminOverride,
  resolveTransition,
  SUBMISSION_STATUSES,
  type ActorRole,
  type SubmissionFacts,
  type SubmissionStatus,
  type WorkflowAction,
} from "@/lib/domain/workflow";

// Written independently from TRANSITIONS, straight from the build spec (section 3), so the
// test catches accidental edits to the table.
const ED: ActorRole[] = ["handling_editor", "admin"];
const NON_FINAL: SubmissionStatus[] = [
  "with_editor",
  "under_review",
  "awaiting_decision",
  "revision_requested",
  "accepted",
];
type Row = [SubmissionStatus, WorkflowAction, SubmissionStatus, ActorRole[], ("revision" | "remaining")[]];
const EXPECTED: Row[] = [
  ["with_editor", "desk_reject", "rejected", ED, []],
  ["with_editor", "send_to_review", "under_review", ED, []],
  ["under_review", "reviews_complete", "awaiting_decision", ["system"], []],
  ["awaiting_decision", "decide_reject", "rejected", ED, []],
  ["awaiting_decision", "decide_major_revision", "revision_requested", ED, ["remaining"]],
  ["awaiting_decision", "decide_minor_revision", "revision_requested", ED, ["remaining"]],
  ["awaiting_decision", "decide_accept", "accepted", ED, []],
  ["with_editor", "decide_reject", "rejected", ED, ["revision"]],
  ["with_editor", "decide_major_revision", "revision_requested", ED, ["revision", "remaining"]],
  ["with_editor", "decide_minor_revision", "revision_requested", ED, ["revision", "remaining"]],
  ["with_editor", "decide_accept", "accepted", ED, ["revision"]],
  ["revision_requested", "submit_revision", "with_editor", ["author"], []],
  ["revision_requested", "revision_expired", "withdrawn", ["system"], []],
  ["accepted", "publish", "published", ["system", "admin"], []],
  ...NON_FINAL.map((s): Row => [s, "withdraw", "withdrawn", ["author"], []]),
];

const ACTIONS: WorkflowAction[] = [
  "desk_reject",
  "send_to_review",
  "reviews_complete",
  "decide_reject",
  "decide_major_revision",
  "decide_minor_revision",
  "decide_accept",
  "submit_revision",
  "revision_expired",
  "publish",
  "withdraw",
];
const ROLES: ActorRole[] = ["author", "handling_editor", "admin", "system"];

/** Facts under which every guard holds. */
const OK_FACTS: SubmissionFacts = { currentVersionNo: 2, revisionCount: 0, maxRevisions: 2 };

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return (e as DomainError).code;
  }
}

describe("workflow transition table", () => {
  for (const from of SUBMISSION_STATUSES) {
    for (const action of ACTIONS) {
      const row = EXPECTED.find((r) => r[0] === from && r[1] === action);
      for (const role of ROLES) {
        const allowed = row && row[3].includes(role);
        it(`${from} --${action}--> as ${role}: ${allowed ? row![2] : "rejected"}`, () => {
          if (allowed) {
            expect(resolveTransition(from, action, role, OK_FACTS)).toBe(row![2]);
          } else {
            const code = codeOf(() => resolveTransition(from, action, role, OK_FACTS));
            // Unknown (state, action) pairs are INVALID_STATE; wrong role on a valid pair is NOT_AUTHORIZED.
            expect(code).toBe(row ? "NOT_AUTHORIZED" : "INVALID_STATE");
          }
        });
      }
    }
  }

  it("final states allow nothing", () => {
    for (const from of ["published", "rejected", "withdrawn"] as const) {
      for (const action of ACTIONS) {
        for (const role of ROLES) {
          expect(codeOf(() => resolveTransition(from, action, role, OK_FACTS))).toBe("INVALID_STATE");
        }
      }
    }
  });
});

describe("workflow guards", () => {
  it("decisions straight from with_editor are only allowed on revised versions", () => {
    const v1: SubmissionFacts = { currentVersionNo: 1, revisionCount: 0, maxRevisions: 2 };
    for (const action of ["decide_reject", "decide_major_revision", "decide_minor_revision", "decide_accept"] as const) {
      expect(codeOf(() => resolveTransition("with_editor", action, "handling_editor", v1))).toBe("INVALID_STATE");
    }
    // Desk reject on v1 is still fine.
    expect(resolveTransition("with_editor", "desk_reject", "handling_editor", v1)).toBe("rejected");
  });

  it("after max_revisions only accept or reject remain", () => {
    const maxed: SubmissionFacts = { currentVersionNo: 3, revisionCount: 2, maxRevisions: 2 };
    for (const from of ["awaiting_decision", "with_editor"] as const) {
      expect(codeOf(() => resolveTransition(from, "decide_major_revision", "handling_editor", maxed))).toBe(
        "INVALID_STATE",
      );
      expect(codeOf(() => resolveTransition(from, "decide_minor_revision", "handling_editor", maxed))).toBe(
        "INVALID_STATE",
      );
      expect(resolveTransition(from, "decide_accept", "handling_editor", maxed)).toBe("accepted");
      expect(resolveTransition(from, "decide_reject", "handling_editor", maxed)).toBe("rejected");
    }
  });

  it("max_revisions = 0 forbids any revision", () => {
    const none: SubmissionFacts = { currentVersionNo: 1, revisionCount: 0, maxRevisions: 0 };
    expect(codeOf(() => resolveTransition("awaiting_decision", "decide_minor_revision", "admin", none))).toBe(
      "INVALID_STATE",
    );
  });
});

describe("admin override", () => {
  it("allows any state to any other state with a reason", () => {
    for (const from of SUBMISSION_STATUSES) {
      for (const to of SUBMISSION_STATUSES) {
        if (from === to) continue;
        expect(resolveAdminOverride(from, to, "Fixing a stuck submission")).toBe(to);
      }
    }
  });

  it("requires a reason and a change", () => {
    expect(codeOf(() => resolveAdminOverride("with_editor", "rejected", " "))).toBe("VALIDATION_ERROR");
    expect(codeOf(() => resolveAdminOverride("with_editor", "with_editor", "no-op change"))).toBe("INVALID_STATE");
  });
});
