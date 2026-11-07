import { randomUUID } from "node:crypto";
import { admins, settings } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { adjustPapercoins } from "@/lib/domain/papercoins";
import { DEFAULT_POLICY, type Policy } from "@/lib/domain/policy";
import { getPlatformSettings } from "@/lib/domain/settings";
import type { ReviewInput, SubmitManuscriptInput } from "@/lib/domain/submissions";

export const T0 = new Date("2026-03-01T12:00:00Z");
export const hours = (h: number, from = T0) => new Date(from.getTime() + h * 3_600_000);

export async function createAdmin(db: Db): Promise<Actor & { type: "admin" }> {
  const [a] = await db
    .insert(admins)
    .values({ email: `admin-${randomUUID()}@example.com`, name: "Admin" })
    .returning();
  return { type: "admin", adminId: a!.id };
}

/** Set the platform policy: defaults overridden by `policy`. */
export async function setPolicy(db: Db, policy: Partial<Policy> = {}) {
  const value = { ...(await getPlatformSettings(db)), policy: { ...DEFAULT_POLICY, ...policy } };
  await db
    .insert(settings)
    .values({ key: "platform", value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

/** An active operator holding plenty of papercoins, as an actor. */
export async function createMember(
  db: Db,
  admin: Actor,
  opts: { name?: string; operatorContact?: string } = {},
): Promise<Actor & { type: "operator" }> {
  const op = await operatorFor(db, opts.name ?? `op-${randomUUID().slice(0, 6)}`, { email: opts.operatorContact });
  // Plenty of papercoins so tests about other rules aren't limited by the economy.
  await adjustPapercoins(db, admin, op.id, 500, "test fixture balance", T0);
  return { type: "operator", operatorId: op.id };
}

/** An operator account (as created on first GitHub sign-in) and its actor. */
export async function createOperator(db: Db, email: string, name = email.split("@")[0]!) {
  const { upsertOperatorFromLogin } = await import("@/lib/domain/operators");
  const op = (await upsertOperatorFromLogin(db, { email, name, githubLogin: name }, T0))!;
  return { operator: op, actor: { type: "operator" as const, operatorId: op.id } };
}

/** An operator account named `name` (created, or reused, by email). */
export async function operatorFor(db: Db, name: string, opts: { email?: string } = {}) {
  const email = (opts.email ?? `${randomUUID()}@operators.test`).toLowerCase();
  return (await createOperator(db, email, name)).operator;
}

/** An operator with an API key, as created on the dashboard. */
export async function createKeyedOperator(db: Db, email: string, name?: string) {
  const { operatorIssueKey } = await import("@/lib/domain/operators");
  const { operator, actor } = await createOperator(db, email, name);
  const k = await operatorIssueKey(db, actor, T0);
  return { operatorId: operator.id, key: k.apiKey };
}

export function manuscript(overrides: Partial<SubmitManuscriptInput> = {}): SubmitManuscriptInput {
  return {
    title: "On the Thermodynamics of Paper Deadlines",
    abstract: "We study deadlines.",
    keywords: ["deadlines", "entropy"],
    bodyMd: "# Introduction\n\nDeadlines approach.",
    coverLetterMd: "Dear editor, please consider our paper.",
    aiDisclosure: "Written entirely by a test fixture.",
    ...overrides,
  };
}

export function review(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    recommendation: "minor_revision",
    summaryMd: "A fine paper with minor issues.",
    strengthsMd: "Clear.",
    weaknessesMd: "Short.",
    detailedCommentsMd: "Expand section 2.",
    confidentialToEditorMd: "CONFIDENTIAL-NOTE",
    confidence: 4,
    scores: { novelty: 3, soundness: 4, clarity: 4, significance: 3 },
    overallScore: 3,
    ...overrides,
  };
}

export const LETTER = "Thank you for your submission. Please see the reviews below.";

// ---------------------------------------------------------------------------
// Task pool helpers: the platform hands out work through request_task.
// ---------------------------------------------------------------------------

type OperatorActor = Actor & { type: "operator" };

/** Ask the pool for a task; fails unless it is of `kind` on `submissionId`. */
export async function takeTask(db: Db, agent: OperatorActor, kind: "review" | "editorial", submissionId: string, now: Date) {
  const { requestTask } = await import("@/lib/domain/pool");
  const r = await requestTask(db, agent, now);
  if (!r.task) throw new Error(`No task for ${agent.operatorId}: ${r.reasons.join(" ")}`);
  if (r.task.kind !== kind || r.task.submissionId !== submissionId) {
    throw new Error(`Expected a ${kind} task on ${submissionId}, got a ${r.task.kind} task on ${r.task.submissionId}`);
  }
  return r;
}

/** Take a review task and return its assignment id. */
export async function takeReview(db: Db, reviewer: OperatorActor, submissionId: string, now: Date) {
  return (await takeTask(db, reviewer, "review", submissionId, now)).assignmentId!;
}

/** Take the editorial task on the submission and send it to review. */
export async function sendOut(db: Db, editor: OperatorActor, submissionId: string, now: Date) {
  const { sendToReview } = await import("@/lib/domain/submissions");
  await takeTask(db, editor, "editorial", submissionId, now);
  return sendToReview(db, editor, submissionId, now);
}

/** Take the editorial task on the submission and decide. */
export async function decide(
  db: Db,
  editor: OperatorActor,
  submissionId: string,
  decision: "accept" | "reject" | "minor_revision" | "major_revision",
  now: Date,
) {
  const { makeDecision } = await import("@/lib/domain/submissions");
  await takeTask(db, editor, "editorial", submissionId, now);
  return makeDecision(db, editor, submissionId, decision, LETTER, now);
}
