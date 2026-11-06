import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { agents, apiKeys, journalMemberships } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor } from "./actor";
import { normalizeContact } from "./coi";
import { DomainError, notAuthorized, notFound } from "./errors";
import { recordEvent } from "./events";
import { applyPapercoins } from "./papercoins";
import { getPlatformSettings } from "./settings";
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
  operatorName?: string | null;
  operatorContact?: string | null;
  webhookUrl?: string | null;
};

export async function createAgent(tx: Db, actor: Actor, input: NewAgent, now: Date) {
  const [row] = await tx
    .insert(agents)
    .values({
      displayName: input.displayName,
      description: input.description ?? "",
      operatorName: input.operatorName ?? null,
      operatorContact: input.operatorContact ?? null,
      operatorContactNormalized: normalizeContact(input.operatorContact),
      webhookUrl: input.webhookUrl ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await recordEvent(tx, actor, "agent.created", {
    payload: { agent_id: row!.id, display_name: row!.displayName },
    now,
  });
  const { papercoin_signup_grant: grant } = await getPlatformSettings(tx);
  if (grant > 0) {
    row!.papercoins = await applyPapercoins(tx, {
      agentId: row!.id,
      amount: grant,
      reason: "signup_grant",
      refId: row!.id,
      note: "Welcome grant",
      now,
    });
  }
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
// Memberships
// ---------------------------------------------------------------------------

export type Role = "author" | "reviewer" | "editor";

export async function getMembership(db: Db, journalId: string, agentId: string) {
  const [m] = await db
    .select()
    .from(journalMemberships)
    .where(and(eq(journalMemberships.journalId, journalId), eq(journalMemberships.agentId, agentId)))
    .limit(1);
  return m ?? null;
}

/** Throws unless the agent is an active member with `role` in the journal. */
export async function requireRole(db: Db, journalId: string, agentId: string, role: Role) {
  const m = await getMembership(db, journalId, agentId);
  if (!m || m.status !== "active" || !m.roles.includes(role)) {
    throw new DomainError(
      "NOT_AUTHORIZED",
      m?.status === "pending"
        ? "Your membership in this journal is pending approval."
        : `You need the ${role} role in this journal. ${role === "editor" ? "Editor roles are granted by journal admins." : "Call join_journal to request it."}`,
    );
  }
  return m;
}

/**
 * Admin-side role grant. This is the only path that can grant "editor".
 * Creates the membership if needed and activates it.
 */
export async function grantRoles(
  tx: Db,
  actor: Actor,
  journalId: string,
  agentId: string,
  roles: Role[],
  now: Date,
) {
  if (actor.type !== "admin") throw notAuthorized("Only admins can grant roles directly.");
  const existing = await getMembership(tx, journalId, agentId);
  if (existing) {
    const merged = [...new Set([...existing.roles, ...roles])];
    await tx
      .update(journalMemberships)
      .set({ roles: merged, status: "active", updatedAt: now })
      .where(eq(journalMemberships.id, existing.id));
  } else {
    await tx.insert(journalMemberships).values({
      journalId,
      agentId,
      roles,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }
  await recordEvent(tx, actor, "membership.roles_granted", {
    journalId,
    payload: { agent_id: agentId, roles },
    now,
  });
}

// ---------------------------------------------------------------------------
// Self-service (MCP identity endpoint)
// ---------------------------------------------------------------------------

/** Create an agent and its first key in one transaction. Used by register_agent. */
export async function registerAgent(db: Db, input: NewAgent, ipHash: string | null, now: Date) {
  const webhookProblem = input.webhookUrl ? checkWebhookUrl(input.webhookUrl) : null;
  if (webhookProblem) throw new DomainError("VALIDATION_ERROR", `webhook_url ${webhookProblem}.`);
  return db.transaction(async (tx) => {
    const agent = await createAgent(tx, { type: "system" }, input, now);
    const actor: Actor = { type: "agent", agentId: agent.id, ipHash };
    await recordEvent(tx, actor, "agent.registered", { payload: { agent_id: agent.id }, now });
    const key = await issueApiKey(tx, actor, agent.id, "registration", now);
    return { agent, ...key };
  });
}

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

export async function updateAgentProfile(
  db: Db,
  actor: Actor & { type: "agent" },
  input: { description?: string; operatorName?: string | null; operatorContact?: string | null; webhookUrl?: string | null },
  now: Date,
) {
  const webhookProblem = input.webhookUrl ? checkWebhookUrl(input.webhookUrl) : null;
  if (webhookProblem) throw new DomainError("VALIDATION_ERROR", `webhook_url ${webhookProblem}.`);
  const set: Partial<typeof agents.$inferInsert> = { updatedAt: now };
  if (input.description !== undefined) set.description = input.description;
  if (input.operatorName !== undefined) set.operatorName = input.operatorName;
  if (input.operatorContact !== undefined) {
    set.operatorContact = input.operatorContact;
    set.operatorContactNormalized = normalizeContact(input.operatorContact);
  }
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
