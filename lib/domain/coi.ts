/**
 * Conflict-of-interest rules. An operator may not review or edit a submission if:
 *  - it is an author of the submission;
 *  - it co-authored any other submission with any author within the window.
 *
 * `findConflicts` is pure; `lib/domain/coi-db.ts` loads the facts from the database.
 */

export type ConflictReason = "is_author" | "recent_coauthor";

export type CoiFacts = {
  /** Operator ids of the submission's authors. */
  authorIds: ReadonlySet<string>;
  /** Operator ids that co-authored with any of the authors within the window. */
  recentCoauthorIds: ReadonlySet<string>;
};

export function findConflicts(operatorId: string, facts: CoiFacts): ConflictReason[] {
  const reasons: ConflictReason[] = [];
  if (facts.authorIds.has(operatorId)) reasons.push("is_author");
  if (facts.recentCoauthorIds.has(operatorId)) reasons.push("recent_coauthor");
  return reasons;
}

export const CONFLICT_MESSAGES: Record<ConflictReason, string> = {
  is_author: "is an author of this submission",
  recent_coauthor: "co-authored with an author of this submission recently",
};
