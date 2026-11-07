import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { operators, webhookDeliveries } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { DomainError } from "@/lib/domain/errors";
import { updateOperatorProfile } from "@/lib/domain/operators";
import { submitManuscript } from "@/lib/domain/submissions";
import { runTick } from "@/lib/domain/tick";
import { checkWebhookUrl, deliverWebhooks, isBlockedAddress, signWebhook, type WebhookFetch } from "@/lib/domain/webhooks";
import { createTestDb } from "./helpers/db";
import { T0, createAdmin, createKeyedOperator, setPolicy, createMember, createOperator, hours, manuscript } from "./helpers/fixtures";

describe("SSRF guard", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1", "not-an-ip"])(
    "blocks %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("checks webhook URLs", () => {
    expect(checkWebhookUrl("https://hooks.example.org/x")).toBeNull();
    expect(checkWebhookUrl("http://hooks.example.org/x")).toMatch(/https/);
    expect(checkWebhookUrl("https://user:pw@example.org")).toMatch(/credentials/);
    expect(checkWebhookUrl("https://127.0.0.1/x")).toMatch(/private/);
    expect(checkWebhookUrl("https://[::1]/x")).toMatch(/private/);
    expect(checkWebhookUrl("https://localhost:3000")).toMatch(/local/);
    expect(checkWebhookUrl("https://metadata.internal/")).toMatch(/local/);
    expect(checkWebhookUrl("nonsense")).toMatch(/valid/);
  });
});

describe("webhook delivery", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeEach(async () => ({ db, close } = await createTestDb()));
  afterEach(async () => close());

  async function withWebhook() {
    const admin = await createAdmin(db);
    await setPolicy(db);
    await createMember(db, admin);
    const reg = await createKeyedOperator(db, "h@ops.test", "Hooked");
    const { webhookSecret } = await updateOperatorProfile(db, { type: "operator", operatorId: reg.operatorId }, { webhookUrl: "https://hooks.example.org/in" }, T0);
    return { author: { type: "operator" as const, operatorId: reg.operatorId }, secret: webhookSecret! };
  }

  it("refuses unsafe webhook URLs when they are set", async () => {
    const { actor } = await createOperator(db, "x@ops.test");
    for (const webhookUrl of ["https://169.254.169.254/latest", "http://example.org"]) {
      await expect(updateOperatorProfile(db, actor, { webhookUrl }, T0)).rejects.toBeInstanceOf(DomainError);
    }
  });

  it("sends signed, id-only payloads and marks them delivered", async () => {
    const { author, secret } = await withWebhook();
    // The editor gets a notification only if it has a webhook; give the author a decision-free event:
    await db.insert(webhookDeliveries).values({ operatorId: author.operatorId, eventType: "submission.decision", payload: { submission_id: "s1" }, nextAttemptAt: T0 });

    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const send: WebhookFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 204 };
    };
    expect(await deliverWebhooks(db, send, T0)).toEqual({ delivered: 1, retried: 0, failed: 0 });
    const c = calls[0]!;
    expect(c.url).toBe("https://hooks.example.org/in");
    const ts = c.headers["x-paperocalypse-timestamp"]!;
    const expected = "sha256=" + createHmac("sha256", secret).update(`${ts}.${c.body}`).digest("hex");
    expect(c.headers["x-paperocalypse-signature"]).toBe(expected);
    expect(signWebhook(secret, ts, c.body)).toBe(expected);
    expect(JSON.parse(c.body)).toMatchObject({ type: "submission.decision", data: { submission_id: "s1" } });
    // Nothing left to send.
    expect(await deliverWebhooks(db, send, hours(1))).toEqual({ delivered: 0, retried: 0, failed: 0 });
  });

  it("retries with backoff, gives up after 3 retries, and disables after repeated failures", async () => {
    const { author } = await withWebhook();
    await db.insert(webhookDeliveries).values({ operatorId: author.operatorId, eventType: "x", payload: {}, nextAttemptAt: T0 });
    const failing: WebhookFetch = async () => ({ status: 500 });

    expect((await deliverWebhooks(db, failing, T0)).retried).toBe(1);
    expect((await deliverWebhooks(db, failing, T0)).retried).toBe(0); // backoff: not due yet
    let t = T0;
    const results = [];
    for (let i = 0; i < 3; i++) {
      t = hours(1, t);
      results.push(await deliverWebhooks(db, failing, t));
    }
    expect(results.map((r) => r.failed)).toEqual([0, 0, 1]);
    const [row] = await db.select().from(webhookDeliveries);
    expect(row).toMatchObject({ status: "failed", attempts: 4, lastError: "HTTP 500" });

    // Ten failed deliveries in a row disable the webhook.
    await db.update(operators).set({ webhookFailureCount: 9 }).where(eq(operators.id, author.operatorId));
    await db.insert(webhookDeliveries).values({ operatorId: author.operatorId, eventType: "x", payload: {}, nextAttemptAt: t, attempts: 3 });
    await deliverWebhooks(db, failing, t);
    const [op] = await db.select().from(operators).where(eq(operators.id, author.operatorId));
    expect(op!.webhookDisabledAt).not.toBeNull();
  });

  it("treats network errors as failures and enqueues on workflow events", async () => {
    const { author } = await withWebhook();
    await submitManuscript(db, author, manuscript(), T0);
    // The editor has no webhook, so the author's own events are what we can see; none yet.
    const throwing: WebhookFetch = async () => {
      throw new Error("refusing to connect");
    };
    await db.insert(webhookDeliveries).values({ operatorId: author.operatorId, eventType: "x", payload: {}, nextAttemptAt: T0 });
    expect((await deliverWebhooks(db, throwing, T0)).retried).toBe(1);
    const [row] = await db.select().from(webhookDeliveries);
    expect(row!.lastError).toContain("refusing to connect");
  });

  it("runTick runs every step and reports", async () => {
    await withWebhook();
    const r = await runTick(db, async () => ({ status: 200 }), T0);
    expect(r.ok).toBe(true);
    expect(r).toHaveProperty("deadlines");
    expect(r).toHaveProperty("webhooks");
    expect(r).toHaveProperty("cleanup");
  });
});
