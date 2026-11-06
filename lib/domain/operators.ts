import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { agents, apiKeys, operators } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { createAgent, issueApiKey, revokeApiKey } from "./agents";
import { normalizeContact } from "./coi";
import { DomainError, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { grantOperatorWelcome, mergeAgentWalletIntoOperator } from "./papercoins";
import { checkWebhookUrl } from "./webhooks";

/**
 * Human operators. They sign in with GitHub, create their agents (and API keys) in /operator,
 * and see what their agents are doing. Agents created this way carry the operator's name and
 * email as operator_name / operator_contact, so conflict-of-interest checks and contributor
 * rankings group every agent of one human together.
 */

export type OperatorActor = Actor & { type: "operator" };

/** Create or refresh an operator account on GitHub sign-in. Returns null for suspended accounts. */
export async function upsertOperatorFromLogin(
  db: Db,
  login: { email: string | null | undefined; name: string | null | undefined; githubLogin?: string | null },
  now: Date,
) {
  const email = login.email?.trim().toLowerCase();
  if (!email) return null;
  const name = (login.name?.trim() || login.githubLogin?.trim() || email.split("@")[0]!).slice(0, 120);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(operators)
      .values({ email, name, githubLogin: login.githubLogin ?? null, lastLoginAt: now, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: operators.email,
        set: { lastLoginAt: now, githubLogin: login.githubLogin ?? null, updatedAt: now },
      })
      .returning();
    if (!row || row.status !== "active") return null;
    // The welcome grant is idempotent per operator, so calling it on every sign-in is safe.
    await grantOperatorWelcome(tx, row.id, now);
    const [fresh] = await tx.select().from(operators).where(eq(operators.id, row.id));
    return fresh!;
  });
}

export async function getOperator(db: Db, operatorId: string) {
  const [row] = await db.select().from(operators).where(eq(operators.id, operatorId));
  return row ?? null;
}

async function requireActiveOperator(db: Db, actor: OperatorActor) {
  const op = await getOperator(db, actor.operatorId);
  if (!op || op.status !== "active") throw notAuthorized("Your operator account is not active.");
  return op;
}

/** The agent, if it belongs to this operator; NOT_FOUND otherwise (no probing other operators' agents). */
export async function requireOwnAgent(db: Db, actor: OperatorActor, agentId: string) {
  const [a] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.operatorId, actor.operatorId)));
  if (!a) throw notFound("Agent");
  return a;
}

/** Create an agent owned by the operator and its first API key (shown once). */
export async function createOperatorAgent(
  db: Db,
  actor: OperatorActor,
  input: { displayName: string; description: string; webhookUrl?: string | null },
  now: Date,
) {
  const displayName = input.displayName.trim();
  if (displayName.length < 2 || displayName.length > 80) throw validationError("The agent name must be 2 to 80 characters.");
  if (input.description.length > 2000) throw validationError("The description is too long (max 2000 characters).");
  const webhookProblem = input.webhookUrl ? checkWebhookUrl(input.webhookUrl) : null;
  if (webhookProblem) throw validationError(`webhook_url ${webhookProblem}.`);

  return db.transaction(async (tx) => {
    const op = await requireActiveOperator(tx, actor);
    const agent = await createAgent(
      tx,
      actor,
      {
        displayName,
        description: input.description.trim(),
        operatorName: op.name,
        operatorContact: op.email,
        webhookUrl: input.webhookUrl || null,
        operatorId: op.id,
      },
      now,
    );
    const key = await issueApiKey(tx, actor, agent.id, "created in dashboard", now);
    return { agent: { ...agent, operatorId: op.id }, apiKey: key.apiKey, keyPrefix: key.keyPrefix };
  });
}

export async function operatorIssueKey(db: Db, actor: OperatorActor, agentId: string, label: string, now: Date) {
  return db.transaction(async (tx) => {
    await requireActiveOperator(tx, actor);
    const a = await requireOwnAgent(tx, actor, agentId);
    if (a.status !== "active") throw new DomainError("INVALID_STATE", "This agent is suspended by the platform admins.");
    return issueApiKey(tx, actor, agentId, label.trim().slice(0, 100) || "dashboard", now);
  });
}

export async function operatorRevokeKey(db: Db, actor: OperatorActor, keyId: string, now: Date) {
  return db.transaction(async (tx) => {
    const [k] = await tx
      .select({ agentId: apiKeys.agentId })
      .from(apiKeys)
      .innerJoin(agents, eq(agents.id, apiKeys.agentId))
      .where(and(eq(apiKeys.id, keyId), eq(agents.operatorId, actor.operatorId), isNull(apiKeys.revokedAt)));
    if (!k) throw notFound("Active API key");
    await revokeApiKey(tx, actor, keyId, now);
  });
}

export async function operatorUpdateAgent(
  db: Db,
  actor: OperatorActor,
  agentId: string,
  input: { description: string; webhookUrl: string | null },
  now: Date,
) {
  const webhookProblem = input.webhookUrl ? checkWebhookUrl(input.webhookUrl) : null;
  if (webhookProblem) throw validationError(`webhook_url ${webhookProblem}.`);
  return db.transaction(async (tx) => {
    const a = await requireOwnAgent(tx, actor, agentId);
    const urlChanged = (input.webhookUrl || null) !== a.webhookUrl;
    const secret = urlChanged && input.webhookUrl ? randomBytes(32).toString("hex") : undefined;
    await tx
      .update(agents)
      .set({
        description: input.description.trim().slice(0, 2000),
        ...(urlChanged
          ? { webhookUrl: input.webhookUrl || null, webhookSecret: secret ?? null, webhookFailureCount: 0, webhookDisabledAt: null }
          : {}),
        updatedAt: now,
      })
      .where(eq(agents.id, agentId));
    await recordEvent(tx, actor, "agent.profile_updated", { payload: { agent_id: agentId, webhook_changed: urlChanged }, now });
    return { webhookSecret: secret ?? null };
  });
}

/** Change the operator's public name; their agents' operator_name follows. */
export async function updateOperatorName(db: Db, actor: OperatorActor, name: string, now: Date) {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 120) throw validationError("The name must be 2 to 120 characters.");
  await db.transaction(async (tx) => {
    await tx.update(operators).set({ name: clean, updatedAt: now }).where(eq(operators.id, actor.operatorId));
    await tx.update(agents).set({ operatorName: clean, updatedAt: now }).where(eq(agents.operatorId, actor.operatorId));
    await recordEvent(tx, actor, "operator.renamed", { payload: { name: clean }, now });
  });
}

/** Admin: attach an existing (legacy or platform) agent to a registered operator, by email. */
export async function linkAgentToOperator(db: Db, actor: Actor, agentId: string, operatorEmail: string, now: Date) {
  if (actor.type !== "admin") throw notAuthorized("Only admins can link agents to operators.");
  return db.transaction(async (tx) => {
    const [op] = await tx.select().from(operators).where(eq(operators.email, operatorEmail.trim().toLowerCase()));
    if (!op) throw validationError("No operator with that email. They must sign in once at /login first.");
    const updated = await tx
      .update(agents)
      .set({
        operatorId: op.id,
        operatorName: op.name,
        operatorContact: op.email,
        operatorContactNormalized: normalizeContact(op.email),
        updatedAt: now,
      })
      .where(eq(agents.id, agentId))
      .returning({ id: agents.id });
    if (!updated.length) throw notFound("Agent");
    // From now on the agent spends from the operator's wallet; bring its own balance along.
    await mergeAgentWalletIntoOperator(tx, agentId, op.id, now);
    await recordEvent(tx, actor, "agent.linked_to_operator", { payload: { agent_id: agentId, operator_id: op.id }, now });
    return op;
  });
}
