import { DomainError } from "./errors";

/**
 * Submission state machine. The TRANSITIONS table is the single source of truth: anything not
 * listed is rejected. `admin_override` (any -> any, with a reason) is handled separately.
 */

/**
 * "with_editor" means an editorial step is pending in the task pool (claimed or not). The database
 * enum still has "submitted", which is no longer used: new submissions start "with_editor".
 */
export const SUBMISSION_STATUSES = [
  "with_editor",
  "under_review",
  "awaiting_decision",
  "revision_requested",
  "accepted",
  "published",
  "rejected",
  "withdrawn",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const FINAL_STATUSES: readonly SubmissionStatus[] = ["published", "rejected", "withdrawn"];
export const isFinal = (s: SubmissionStatus) => FINAL_STATUSES.includes(s);

/** Who is performing an action, relative to the submission. The handling editor is the agent holding the submission's editorial task. */
export type ActorRole = "author" | "handling_editor" | "admin" | "system";

export type WorkflowAction =
  | "desk_reject"
  | "send_to_review"
  | "reviews_complete"
  | "decide_reject"
  | "decide_major_revision"
  | "decide_minor_revision"
  | "decide_accept"
  | "submit_revision"
  | "revision_expired"
  | "publish"
  | "withdraw";

/** Conditions checked against submission facts in addition to state and role. */
export type Guard =
  /** Decision on a revised version straight from with_editor, without a new review round. */
  | "is_revision"
  /** Revision rounds remain (revision_count < max_revisions). */
  | "revisions_remaining";

export type Transition = {
  from: SubmissionStatus;
  action: WorkflowAction;
  to: SubmissionStatus;
  roles: readonly ActorRole[];
  guards?: readonly Guard[];
};

const EDITOR: readonly ActorRole[] = ["handling_editor", "admin"];
const NON_FINAL = SUBMISSION_STATUSES.filter((s) => !isFinal(s));

export const TRANSITIONS: readonly Transition[] = [
  { from: "with_editor", action: "desk_reject", to: "rejected", roles: EDITOR },
  // Opens review tasks in the pool; reviewers take them with request_task.
  { from: "with_editor", action: "send_to_review", to: "under_review", roles: EDITOR },
  { from: "under_review", action: "reviews_complete", to: "awaiting_decision", roles: ["system"] },

  { from: "awaiting_decision", action: "decide_reject", to: "rejected", roles: EDITOR },
  {
    from: "awaiting_decision",
    action: "decide_major_revision",
    to: "revision_requested",
    roles: EDITOR,
    guards: ["revisions_remaining"],
  },
  {
    from: "awaiting_decision",
    action: "decide_minor_revision",
    to: "revision_requested",
    roles: EDITOR,
    guards: ["revisions_remaining"],
  },
  { from: "awaiting_decision", action: "decide_accept", to: "accepted", roles: EDITOR },

  // After a revision the editor "may re-review or decide": deciding straight from with_editor
  // is allowed only for revised versions (earlier rounds' reviews satisfy the minimum).
  {
    from: "with_editor",
    action: "decide_reject",
    to: "rejected",
    roles: EDITOR,
    guards: ["is_revision"],
  },
  {
    from: "with_editor",
    action: "decide_major_revision",
    to: "revision_requested",
    roles: EDITOR,
    guards: ["is_revision", "revisions_remaining"],
  },
  {
    from: "with_editor",
    action: "decide_minor_revision",
    to: "revision_requested",
    roles: EDITOR,
    guards: ["is_revision", "revisions_remaining"],
  },
  {
    from: "with_editor",
    action: "decide_accept",
    to: "accepted",
    roles: EDITOR,
    guards: ["is_revision"],
  },

  { from: "revision_requested", action: "submit_revision", to: "with_editor", roles: ["author"] },
  { from: "revision_requested", action: "revision_expired", to: "withdrawn", roles: ["system"] },
  // Accepting publishes immediately (as system); admins can also publish.
  { from: "accepted", action: "publish", to: "published", roles: ["system", "admin"] },

  ...NON_FINAL.map(
    (from): Transition => ({ from, action: "withdraw", to: "withdrawn", roles: ["author"] }),
  ),
];

export type SubmissionFacts = {
  currentVersionNo: number;
  revisionCount: number;
  maxRevisions: number;
};

function guardHolds(guard: Guard, facts: SubmissionFacts): boolean {
  switch (guard) {
    case "is_revision":
      return facts.currentVersionNo > 1;
    case "revisions_remaining":
      return facts.revisionCount < facts.maxRevisions;
  }
}

const GUARD_MESSAGES: Record<Guard, string> = {
  is_revision:
    "A decision without a review round is only possible on a revised version. Invite reviewers first.",
  revisions_remaining:
    "The maximum number of revision rounds has been reached; the only possible decisions are accept or reject.",
};

/** Actions available in a state (ignoring role and guards). */
export function actionsFrom(status: SubmissionStatus): WorkflowAction[] {
  return [...new Set(TRANSITIONS.filter((t) => t.from === status).map((t) => t.action))];
}

/**
 * Resolve a transition or throw. Checks, in order: the (state, action) pair exists, the actor's
 * role is allowed, and all guards hold. Returns the target state.
 */
export function resolveTransition(
  from: SubmissionStatus,
  action: WorkflowAction,
  role: ActorRole,
  facts: SubmissionFacts,
): SubmissionStatus {
  const candidates = TRANSITIONS.filter((t) => t.from === from && t.action === action);
  if (candidates.length === 0) {
    const allowed = actionsFrom(from);
    throw new DomainError(
      "INVALID_STATE",
      `Cannot ${action.replaceAll("_", " ")} a submission that is ${from}.` +
        (allowed.length ? ` Possible actions now: ${allowed.join(", ")}.` : " It is final."),
      { status: from, action },
    );
  }
  const byRole = candidates.filter((t) => t.roles.includes(role));
  if (byRole.length === 0) {
    throw new DomainError("NOT_AUTHORIZED", `Only ${candidates[0]!.roles.join(" or ")} may ${action.replaceAll("_", " ")}.`, {
      status: from,
      action,
    });
  }
  const ok = byRole.find((t) => (t.guards ?? []).every((g) => guardHolds(g, facts)));
  if (!ok) {
    const failed = (byRole[0]!.guards ?? []).find((g) => !guardHolds(g, facts))!;
    throw new DomainError("INVALID_STATE", GUARD_MESSAGES[failed], { status: from, action, guard: failed });
  }
  return ok.to;
}

/** Admin override: any state to any other state, with a mandatory reason. */
export function resolveAdminOverride(
  from: SubmissionStatus,
  to: SubmissionStatus,
  reason: string,
): SubmissionStatus {
  if (reason.trim().length < 5) {
    throw new DomainError("VALIDATION_ERROR", "An admin override needs a reason (at least 5 characters).");
  }
  if (from === to) {
    throw new DomainError("INVALID_STATE", `The submission is already ${to}.`);
  }
  return to;
}
