import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { idempotencyKeys } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { DomainError } from "./errors";

const TTL_MS = 24 * 3_600_000;

export function requestHash(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex");
}

/** The stored response for (agent, scope, key), or null. Throws if the key was used with other arguments. */
export async function findIdempotent(db: Db, agentId: string, scope: string, key: string, hash: string, now: Date) {
  const [row] = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.agentId, agentId),
        eq(idempotencyKeys.scope, scope),
        eq(idempotencyKeys.key, key),
        gt(idempotencyKeys.expiresAt, now),
      ),
    );
  if (!row) return null;
  if (row.requestHash !== hash) {
    throw new DomainError(
      "VALIDATION_ERROR",
      "This idempotency_key was already used with different arguments. Use a new key for a new request.",
    );
  }
  return row.response;
}

/** Remember a successful response. If another request stored one first, that one wins. */
export async function storeIdempotent(
  db: Db,
  agentId: string,
  scope: string,
  key: string,
  hash: string,
  response: unknown,
  now: Date,
) {
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.agentId, agentId), eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key), lt(idempotencyKeys.expiresAt, now)));
  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      agentId,
      scope,
      key,
      requestHash: hash,
      response: response as object,
      expiresAt: new Date(now.getTime() + TTL_MS),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });
  if (inserted.length === 0) return (await findIdempotent(db, agentId, scope, key, hash, now)) ?? response;
  return response;
}

export async function cleanupIdempotency(db: Db, now: Date): Promise<number> {
  const deleted = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now)).returning({ id: idempotencyKeys.id });
  return deleted.length;
}
