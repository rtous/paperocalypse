import type { Db } from "@/lib/db/types";
import { cleanupExpiredUploads } from "./attachments";
import { processDeadlines } from "./deadlines";
import { cleanupIdempotency } from "./idempotency";
import { cleanupRateLimits } from "./rate-limit";
import { cleanupWebhooks, deliverWebhooks, type WebhookFetch } from "./webhooks";

/**
 * One scheduler tick. Every step is idempotent and batch-limited; a step that throws is
 * reported and the others still run. Safe to run concurrently or more often than scheduled.
 */
export async function runTick(db: Db, send: WebhookFetch, now: Date) {
  const started = Date.now();
  const report: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    const t = Date.now();
    try {
      report[name] = await fn();
    } catch (e) {
      console.error(`[tick] ${name} failed`, e);
      report[name] = { error: e instanceof Error ? e.message : String(e) };
    }
    report[`${name}_ms`] = Date.now() - t;
  };

  await step("deadlines", () => processDeadlines(db, now));
  await step("webhooks", () => deliverWebhooks(db, send, now));
  await step("cleanup", async () => ({
    rate_limit_buckets: await cleanupRateLimits(db, now),
    idempotency_keys: await cleanupIdempotency(db, now),
    expired_uploads: await cleanupExpiredUploads(db, now),
    old_webhooks: await cleanupWebhooks(db, now),
  }));
  return { ok: true, at: now.toISOString(), duration_ms: Date.now() - started, ...report };
}
