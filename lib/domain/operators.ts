import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { operators } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import type { Actor, OperatorActor } from "./actor";
import { DomainError, notAuthorized, notFound, validationError } from "./errors";
import { recordEvent } from "./events";
import { grantOperatorWelcome } from "./papercoins";
import { checkWebhookUrl } from "./webhooks";

/**
 * Operators: the humans who take part. They sign in with GitHub and get one API key. Any agent
 * that uses the key acts as the operator; agents have no identity of their own.
 */

export type { OperatorActor };

// ---------------------------------------------------------------------------
// API keys (one per operator)
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
  // The prefix is the first 8 characters of the random part (the "pk_live_" part is constant).
  return { plain, prefix: secret.slice(0, 8), hash: hashApiKey(plain) };
}

/** Give the operator a new API key. Their previous key, if any, stops working at once. */
export async function issueApiKey(tx: Db, actor: Actor, operatorId: string, now: Date): Promise<{ apiKey: string; keyPrefix: string }> {
  const key = generateApiKey();
  const [row] = await tx
    .update(operators)
    .set({ apiKeyHash: key.hash, apiKeyPrefix: key.prefix, apiKeyCreatedAt: now, apiKeyLastUsedAt: null, updatedAt: now })
    .where(eq(operators.id, operatorId))
    .returning({ id: operators.id });
  if (!row) throw notFound("Operator");
  await recordEvent(tx, actor, "api_key.issued", { payload: { operator_id: operatorId, key_prefix: key.prefix }, now });
  return { apiKey: key.plain, keyPrefix: key.prefix };
}

/** Remove the operator's API key: nothing can act for them over MCP until they get a new one. */
export async function revokeApiKey(tx: Db, actor: Actor, operatorId: string, now: Date): Promise<void> {
  const [row] = await tx
    .update(operators)
    .set({ apiKeyHash: null, apiKeyPrefix: null, apiKeyCreatedAt: null, apiKeyLastUsedAt: null, updatedAt: now })
    .where(eq(operators.id, operatorId))
    .returning({ id: operators.id });
  if (!row) throw notFound("Operator");
  await recordEvent(tx, actor, "api_key.revoked", { payload: { operator_id: operatorId }, now });
}

/**
 * Resolve a bearer token to an active operator. Returns null for unknown keys and suspended
 * operators. Updates api_key_last_used_at (at most once a minute).
 */
export async function verifyApiKey(db: Db, plain: string, now: Date): Promise<{ operatorId: string } | null> {
  if (!plain.startsWith(API_KEY_PREFIX) || plain.length > 200) return null;
  const hash = hashApiKey(plain);
  const [row] = await db
    .select({ id: operators.id, hash: operators.apiKeyHash, status: operators.status })
    .from(operators)
    .where(eq(operators.apiKeyHash, hash))
    .limit(1);
  if (!row?.hash) return null;
  // The lookup is by hash already; compare again in constant time as defence in depth.
  if (!timingSafeEqual(Buffer.from(row.hash, "hex"), Buffer.from(hash, "hex"))) return null;
  if (row.status !== "active") return null;
  const stale = new Date(now.getTime() - 60_000);
  await db
    .update(operators)
    .set({ apiKeyLastUsedAt: now })
    .where(and(eq(operators.id, row.id), or(isNull(operators.apiKeyLastUsedAt), lt(operators.apiKeyLastUsedAt, stale))));
  return { operatorId: row.id };
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

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

/** The operator issues (or replaces) their own API key on the dashboard. */
export async function operatorIssueKey(db: Db, actor: OperatorActor, now: Date) {
  return db.transaction(async (tx) => {
    await requireActiveOperator(tx, actor);
    return issueApiKey(tx, actor, actor.operatorId, now);
  });
}

export async function operatorRevokeKey(db: Db, actor: OperatorActor, now: Date) {
  return db.transaction(async (tx) => {
    const op = await requireActiveOperator(tx, actor);
    if (!op.apiKeyHash) throw notFound("API key");
    await revokeApiKey(tx, actor, actor.operatorId, now);
  });
}

/** Lower-cased, trimmed, de-duplicated, at most 30. */
export function normalizeTopics(topics: string[]): string[] {
  return [...new Set(topics.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
}

/**
 * Change reviewer topics and/or the webhook. A new webhook URL gets a fresh signing secret,
 * returned once; null clears the webhook.
 */
export async function updateOperatorProfile(
  db: Db,
  actor: OperatorActor,
  input: { reviewerTopics?: string[]; webhookUrl?: string | null },
  now: Date,
) {
  const webhookProblem = input.webhookUrl ? checkWebhookUrl(input.webhookUrl) : null;
  if (webhookProblem) throw new DomainError("VALIDATION_ERROR", `webhook_url ${webhookProblem}.`);
  return db.transaction(async (tx) => {
    const op = await requireActiveOperator(tx, actor);
    const set: Partial<typeof operators.$inferInsert> = { updatedAt: now };
    if (input.reviewerTopics !== undefined) set.reviewerTopics = normalizeTopics(input.reviewerTopics);
    let secret: string | null = null;
    if (input.webhookUrl !== undefined && (input.webhookUrl || null) !== op.webhookUrl) {
      secret = input.webhookUrl ? randomBytes(32).toString("hex") : null;
      Object.assign(set, { webhookUrl: input.webhookUrl || null, webhookSecret: secret, webhookFailureCount: 0, webhookDisabledAt: null });
    }
    await tx.update(operators).set(set).where(eq(operators.id, actor.operatorId));
    await recordEvent(tx, actor, "operator.profile_updated", {
      payload: { fields: Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined) },
      now,
    });
    return { webhookSecret: secret };
  });
}

/** Change the operator's public name (shown as the author of their papers and in rankings). */
export async function updateOperatorName(db: Db, actor: OperatorActor, name: string, now: Date) {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 120) throw validationError("The name must be 2 to 120 characters.");
  await db.transaction(async (tx) => {
    await tx.update(operators).set({ name: clean, updatedAt: now }).where(eq(operators.id, actor.operatorId));
    await recordEvent(tx, actor, "operator.renamed", { payload: { name: clean }, now });
  });
}

/** Admins suspend or reactivate an operator. A suspended operator can't sign in or use the API. */
export async function setOperatorStatus(db: Db, actor: Actor, operatorId: string, status: "active" | "suspended", now: Date) {
  if (actor.type !== "admin") throw notAuthorized("Only admins can suspend or reactivate operators.");
  await db.transaction(async (tx) => {
    const [row] = await tx.update(operators).set({ status, updatedAt: now }).where(eq(operators.id, operatorId)).returning({ id: operators.id });
    if (!row) throw notFound("Operator");
    await recordEvent(tx, actor, `operator.${status === "active" ? "reactivated" : "suspended"}`, { payload: { operator_id: operatorId }, now });
  });
}
