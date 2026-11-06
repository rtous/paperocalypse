import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { agents, webhookDeliveries } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";

/**
 * Webhook delivery. Payloads carry event type and ids only, never content. Each POST is signed:
 *   x-paperocalypse-signature: sha256=HMAC_SHA256(secret, `${timestamp}.${body}`)
 * Only https URLs; private, loopback and link-local addresses are refused at connect time
 * (see lib/webhook-fetch.ts). No redirects, 5 s timeout, at most 3 retries with backoff.
 * After 10 consecutive failed deliveries the agent's webhook is disabled.
 */

export const MAX_ATTEMPTS = 4; // the first try + 3 retries
export const DISABLE_AFTER_FAILURES = 10;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000];

export type WebhookFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** True for addresses a webhook must never reach (private, loopback, link-local, reserved). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (v === "::" || v === "::1") return true;
    const first = parseInt(v.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (v.startsWith("64:ff9b:") || v.startsWith("2001:db8:")) return true; // NAT64, documentation
    return false;
  }
  return true;
}

/** Static checks on a webhook URL (scheme, credentials, literal IPs). DNS is checked at connect time. */
export function checkWebhookUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username || url.password) return "must not contain credentials";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) return "points to a private or reserved address";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return "points to a local hostname";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Deliver due webhooks. Rows are claimed with FOR UPDATE SKIP LOCKED, so concurrent ticks never
 * deliver the same row twice. Returns counts.
 */
export async function deliverWebhooks(db: Db, send: WebhookFetch, now: Date, batchSize = 50) {
  const result = { delivered: 0, retried: 0, failed: 0 };
  const due = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now)))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(batchSize);

  for (const { id } of due) {
    const outcome = await db.transaction(async (tx) => {
      const [d] = await tx
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.status, "pending")))
        .for("update", { skipLocked: true });
      if (!d || d.nextAttemptAt > now) return null;
      const [agent] = await tx.select().from(agents).where(eq(agents.id, d.agentId));

      const fail = async (error: string, permanent = false) => {
        const attempts = d.attempts + 1;
        const final = permanent || attempts >= MAX_ATTEMPTS;
        await tx
          .update(webhookDeliveries)
          .set({
            attempts,
            status: final ? "failed" : "pending",
            lastError: error.slice(0, 500),
            nextAttemptAt: final ? d.nextAttemptAt : new Date(now.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!),
            updatedAt: now,
          })
          .where(eq(webhookDeliveries.id, d.id));
        if (final && agent) {
          const failures = agent.webhookFailureCount + 1;
          await tx
            .update(agents)
            .set({
              webhookFailureCount: failures,
              ...(failures >= DISABLE_AFTER_FAILURES && !agent.webhookDisabledAt ? { webhookDisabledAt: now } : {}),
              updatedAt: now,
            })
            .where(eq(agents.id, agent.id));
        }
        return final ? "failed" : "retried";
      };

      if (!agent?.webhookUrl || !agent.webhookSecret || agent.webhookDisabledAt || agent.status !== "active") {
        return fail("webhook not configured, disabled or agent suspended", true);
      }
      const bad = checkWebhookUrl(agent.webhookUrl);
      if (bad) return fail(`webhook_url ${bad}`, true);

      const timestamp = String(Math.floor(now.getTime() / 1000));
      const body = JSON.stringify({ id: d.id, type: d.eventType, created_at: d.createdAt.toISOString(), data: d.payload });
      try {
        const res = await send(agent.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Paperocalypse-Webhooks/1.0",
            "x-paperocalypse-event": d.eventType,
            "x-paperocalypse-delivery": d.id,
            "x-paperocalypse-timestamp": timestamp,
            "x-paperocalypse-signature": signWebhook(agent.webhookSecret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (res.status >= 200 && res.status < 300) {
          await tx
            .update(webhookDeliveries)
            .set({ status: "delivered", attempts: d.attempts + 1, deliveredAt: now, lastError: null, updatedAt: now })
            .where(eq(webhookDeliveries.id, d.id));
          if (agent.webhookFailureCount > 0) {
            await tx.update(agents).set({ webhookFailureCount: 0, updatedAt: now }).where(eq(agents.id, agent.id));
          }
          return "delivered";
        }
        return fail(`HTTP ${res.status}`);
      } catch (e) {
        return fail(e instanceof Error ? `${e.name}: ${e.message}` : "request failed");
      }
    });
    if (outcome) result[outcome]++;
  }
  return result;
}

/** Remove delivered or failed webhook rows older than 30 days. */
export async function cleanupWebhooks(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await db
    .delete(webhookDeliveries)
    .where(and(sql`${webhookDeliveries.status} <> 'pending'`, lte(webhookDeliveries.updatedAt, cutoff)))
    .returning({ id: webhookDeliveries.id });
  return rows.length;
}
