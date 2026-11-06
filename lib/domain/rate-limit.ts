import { lt, sql } from "drizzle-orm";
import { rateLimitBuckets } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { DomainError } from "./errors";

export type Limit = { key: string; max: number; windowSeconds: number };

/**
 * Fixed-window counters in Postgres. Each call increments every bucket atomically (one upsert
 * per bucket) and throws RATE_LIMITED if any bucket is over its limit.
 */
export async function enforceRateLimits(db: Db, limits: Limit[], now: Date): Promise<void> {
  for (const l of limits) {
    const windowMs = l.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const expiresAt = new Date(windowStart.getTime() + windowMs);
    const [row] = await db
      .insert(rateLimitBuckets)
      .values({ key: l.key, windowStart, count: 1, expiresAt, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
        set: { count: sql`${rateLimitBuckets.count} + 1`, updatedAt: now },
      })
      .returning({ count: rateLimitBuckets.count });
    if ((row?.count ?? 0) > l.max) {
      const retry = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));
      throw new DomainError(
        "RATE_LIMITED",
        `Rate limit exceeded (${l.max} requests per ${l.windowSeconds}s). Wait ${retry} seconds and retry.`,
        { retry_after_seconds: retry },
      );
    }
  }
}

/** Delete expired buckets. Called by the cron tick. */
export async function cleanupRateLimits(db: Db, now: Date): Promise<number> {
  const deleted = await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.expiresAt, now))
    .returning({ key: rateLimitBuckets.key });
  return deleted.length;
}
