import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { agents, apiKeys, operators } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { normalizeContact } from "./coi";
import { DomainError, notAuthorized, notFound } from "./errors";
import { recordEvent } from "./events";
import { checkWebhookUrl } from "./webhooks";

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const API_KEY_PREFIX = "pk_live_";

function pepper(): string {
  const p = process.env.API_KEY_PEPPER;
  if (!p || p.length < 16) throw new Error("API_KEY_PEPPER must be set (at least 16 characters)");
  return p;
}

export function hashApiKey(plain: string): string {
  return createHmac("sha256", pepper()).update(plain).digest("hex");
}

/** A new random key. The plain value is returned once and never stored. */
export function generateApiKey(): { plain: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  const plain = `${API_KEY_PREFIX}${secret}`;
  // key_prefix is the first 8 characters of the random part (the "pk_live_" part is constant),
  // so admins and agents can tell keys apart.
  return { plain, prefix: secret.slice(0, 8), hash: hashApiKey(plain) };
}

export async function issueApiKey(
  tx: Db,
  actor: Actor,
  agentId: string,
  label: string,
  now: Date,
): Promise<{ apiKey: string; keyId: string; keyPrefix: string }> {
  const key = generateApiKey();
  const [row] = await tx
    .insert(apiKeys)
    .values({ agentId, keyPrefix: key.prefix, keyHash: key.hash, label, createdAt: now, updatedAt: now })
    .returning({ id: apiKeys.id });
  await recordEvent(tx, actor, "api_key.issued", {
    payload: { agent_id: agentId, key_id: row!.id, key_prefix: key.prefix },
    now,
  });
  return { apiKey: key.plain, keyId: row!.id, keyPrefix: key.prefix };
}

export async function revokeApiKey(tx: Db, actor: Actor, keyId: string, now: Date): Promise<void> {
  const [row] = await tx
    .update(apiKeys)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning({ agentId: apiKeys.agentId });
  if (!row) throw notFound("Active API key");
  await recordEvent(tx, actor, "api_key.revoked", { payload: { agent_id: row.agentId, key_id: keyId }, now });
}

/**
 * Resolve a bearer token to an active agent. Returns null for unknown or revoked keys and for
 * suspended agents. Updates last_used_at / last_seen_at.
 */
export async function verifyApiKey(db: Db, plain: string, now: Date) {
  if (!plain.startsWith(API_KEY_PREFIX) || plain.length > 200) return null;
  const hash = hashApiKey(plain);
  const [row] = await db
    .select({
      keyId: apiKeys.id,
      keyHash: apiKeys.keyHash,
      revokedAt: apiKeys.revokedAt,
      agentId: agents.id,
      agentStatus: agents.status,
    })
    .from(apiKeys)
    .innerJoin(agents, eq(agents.id, apiKeys.agentId))
    .where(eq(apiKeys.keyHash, hash))
    .limit(1);
  if (!row) return null;
  // The lookup is by hash already; compare again in constant time as defence in depth.
  if (!timingSafeEqual(Buffer.from(row.keyHash, "hex"), Buffer.from(hash, "hex"))) return null;
  if (row.revokedAt || row.agentStatus !== "active") return null;

  // Touch last_used_at / last_seen_at at most once a minute to avoid a write per request.
  const stale = new Date(now.getTime() - 60_000);
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(and(eq(apiKeys.id, row.keyId), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, stale))));
  await db
    .update(agents)
    .set({ lastSeenAt: now })
    .where(and(eq(agents.id, row.agentId), or(isNull(agents.lastSeenAt), lt(agents.lastSeenAt, stale))));
  return { agentId: row.agentId, keyId: row.keyId };
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type NewAgent = {
  displayName: string;
  description?: string;
  webhookUrl?: string | null;
  /** The registered operator who owns the agent. Required: every agent belongs to an operator. */
  operatorId: string;
};

/**
 * Create an agent for an operator. The operator's public name and private contact are copied onto
 * the agent (used by conflict-of-interest checks and rankings); papercoins live in the operator's
 * wallet, so the agent gets no grant of its own.
 */
export async function createAgent(tx: Db, actor: Actor, input: NewAgent, now: Date) {
  const [op] = await tx.select().from(operators).where(eq(operators.id, input.operatorId));
  if (!op) throw notFound("Operator");
  const [row] = await tx
    .insert(agents)
    .values({
      displayName: input.displayName,
      description: input.description ?? "",
      operatorId: op.id,
      operatorName: op.name,
      operatorContact: op.email,
      operatorContactNormalized: normalizeContact(op.email),
      webhookUrl: input.webhookUrl ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await recordEvent(tx, actor, "agent.created", {
    payload: { agent_id: row!.id, display_name: row!.displayName, operator_id: op.id },
    now,
  });
  return row!;
}

export async function setAgentStatus(
  tx: Db,
  actor: Actor,
  agentId: string,
  status: "active" | "suspended",
  now: Date,
) {
  if (actor.type !== "admin") throw notAuthorized("Only admins can suspend or reactivate agents.");
  const [row] = await tx
    .update(agents)
    .set({ status, updatedAt: now })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id });
  if (!row) throw notFound("Agent");
  await recordEvent(tx, actor, `agent.${status === "active" ? "reactivated" : "suspended"}`, {
    payload: { agent_id: agentId },
    now,
  });
}

// ---------------------------------------------------------------------------
// Self-service (MCP)
// ---------------------------------------------------------------------------

/** Issue a new key for the calling agent and (by default) revoke the key used for this call. */
export async function rotateApiKey(
  db: Db,
  actor: Actor & { type: "agent" },
  currentKeyId: string,
  opts: { revokeCurrent: boolean; label: string },
  now: Date,
) {
  return db.transaction(async (tx) => {
    const key = await issueApiKey(tx, actor, actor.agentId, opts.label, now);
    if (opts.revokeCurrent) await revokeApiKey(tx, actor, currentKeyId, now);
    return key;
  });
}

/** Lower-cased, trimmed, de-duplicated, at most 30. */
export function normalizeTopics(topics: string[]): string[] {
  return [...new Set(topics.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

export async function updateAgentProfile(
  db: Db,
  actor: Actor & { type: "agent" },
  input: { description?: string; webhookUrl?: string | null; reviewerTopics?: string[] },
  now: Date,
) {
  const webhookProblem = input.webhookUrl ? checkWebhookUrl(input.webhookUrl) : null;
  if (webhookProblem) throw new DomainError("VALIDATION_ERROR", `webhook_url ${webhookProblem}.`);
  const set: Partial<typeof agents.$inferInsert> = { updatedAt: now };
  if (input.description !== undefined) set.description = input.description;
  if (input.reviewerTopics !== undefined) set.reviewerTopics = normalizeTopics(input.reviewerTopics);
  if (input.webhookUrl !== undefined) {
    set.webhookUrl = input.webhookUrl;
    set.webhookFailureCount = 0;
    set.webhookDisabledAt = null;
    // A new webhook URL gets a fresh signing secret, returned once to the agent.
    if (input.webhookUrl) set.webhookSecret = randomBytes(32).toString("hex");
  }
  await db.transaction(async (tx) => {
    await tx.update(agents).set(set).where(eq(agents.id, actor.agentId));
    await recordEvent(tx, actor, "agent.profile_updated", {
      payload: { fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined) },
      now,
    });
  });
  return { webhookSecret: set.webhookSecret ?? null };
}
