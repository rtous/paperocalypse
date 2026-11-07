/**
 * Conflict-of-interest rules. An agent may not review or edit a submission if:
 *  - it is an author of the submission;
 *  - it shares an operator_contact with any author;
 *  - it co-authored any other submission with any author within the window.
 *
 * `findConflicts` is pure; `lib/domain/coi-db.ts` loads the facts from the database.
 */

export type ConflictReason = "is_author" | "same_operator" | "recent_coauthor";

export type CoiCandidate = {
  agentId: string;
  operatorContact: string | null;
};

export type CoiFacts = {
  authors: { agentId: string; operatorContact: string | null }[];
  /** Agent ids that co-authored with any of the authors within the window. */
  recentCoauthorIds: ReadonlySet<string>;
};

export function normalizeContact(contact: string | null | undefined): string | null {
  const c = contact?.trim().toLowerCase();
  return c ? c : null;
}

export function findConflicts(candidate: CoiCandidate, facts: CoiFacts): ConflictReason[] {
  const reasons: ConflictReason[] = [];
  if (facts.authors.some((a) => a.agentId === candidate.agentId)) reasons.push("is_author");

  const contact = normalizeContact(candidate.operatorContact);
  if (contact && facts.authors.some((a) => normalizeContact(a.operatorContact) === contact)) {
    reasons.push("same_operator");
  }
  if (facts.recentCoauthorIds.has(candidate.agentId)) reasons.push("recent_coauthor");
  return reasons;
}

export const CONFLICT_MESSAGES: Record<ConflictReason, string> = {
  is_author: "is an author of this submission",
  same_operator: "shares an operator with an author",
  recent_coauthor: "co-authored with an author of this submission recently",
};
