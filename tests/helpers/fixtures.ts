import { randomUUID } from "node:crypto";
import { admins, journals } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "@/lib/domain/actor";
import { createAgent, grantRoles, type Role } from "@/lib/domain/agents";
import { adjustPapercoins } from "@/lib/domain/papercoins";
import { DEFAULT_POLICY, type JournalPolicy } from "@/lib/domain/policy";
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

export async function createJournal(db: Db, policy: Partial<JournalPolicy> = {}) {
  const slug = `j-${randomUUID().slice(0, 8)}`;
  const [j] = await db
    .insert(journals)
    .values({
      slug,
      name: `Journal ${slug}`,
      status: "open",
      policy: { ...DEFAULT_POLICY, ...policy },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning();
  return j!;
}

export async function createMember(
  db: Db,
  admin: Actor,
  journalId: string,
  roles: Role[],
  opts: { name?: string; operatorContact?: string } = {},
): Promise<Actor & { type: "agent" }> {
  const agent = await createAgent(
    db,
    admin,
    {
      displayName: opts.name ?? `agent-${randomUUID().slice(0, 6)}`,
      operatorContact: opts.operatorContact ?? `${randomUUID()}@operators.test`,
    },
    T0,
  );
  await grantRoles(db, admin, journalId, agent.id, roles, T0);
  // Plenty of papercoins so tests about other rules aren't limited by the economy.
  await adjustPapercoins(db, admin, agent.id, 500, "test fixture balance", T0);
  return { type: "agent", agentId: agent.id };
}

/** An operator account (as created on first GitHub sign-in) and its actor. */
export async function createOperator(db: Db, email: string, name = email.split("@")[0]!) {
  const { upsertOperatorFromLogin } = await import("@/lib/domain/operators");
  const op = (await upsertOperatorFromLogin(db, { email, name, githubLogin: name }, T0))!;
  return { operator: op, actor: { type: "operator" as const, operatorId: op.id } };
}

/** An agent created from an operator's dashboard, with its API key. */
export async function createDashboardAgent(db: Db, operatorEmail: string, name: string) {
  const { createOperatorAgent } = await import("@/lib/domain/operators");
  const { actor } = await createOperator(db, operatorEmail);
  const r = await createOperatorAgent(db, actor, { displayName: name, description: `${name}, a scripted test agent` }, T0);
  return { agentId: r.agent.id, key: r.apiKey };
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
    ...overrides,
  };
}

export const LETTER = "Thank you for your submission. Please see the reviews below.";
