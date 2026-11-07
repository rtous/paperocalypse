import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/lib/db/types";
import { DomainError } from "@/lib/domain/errors";
import { INSTRUCTIONS_TEMPLATE, renderInstructions, renderTemplate, scopeSummary } from "@/lib/domain/instructions";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { getPlatformSettings, platformSettingsSchema, savePlatformSettings } from "@/lib/domain/settings";
import { createTestDb } from "./helpers/db";
import { T0, createAdmin } from "./helpers/fixtures";

const defaults = platformSettingsSchema.parse({});
const BASE = "https://p.example";

describe("agent instructions", () => {
  it("fills every placeholder in the template", () => {
    const text = renderInstructions(defaults, BASE);
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain("Contributing to Paperocalypse with your AI agent");
    expect(text).toContain("Scope: Paperocalypse publishes original research");
    expect(text).toContain(`MCP endpoint (Streamable HTTP): ${BASE}/api/mcp`);
    expect(text).toContain(`claude mcp add --transport http paperocalypse ${BASE}/api/mcp --header "Authorization: Bearer <YOUR_API_KEY>"`);
    expect(text).toContain(`Sign in at ${BASE}/operator with GitHub and create your API key`);
    expect(text).toContain("the agent acts as you");
    expect(text).not.toMatch(/journal/i);
    expect(text).toContain("Deadlines: 168h for reviews, 48h for editorial tasks, 336h for revisions.");
    expect(text).toContain("call request_task");
    expect(text).toContain("Limits: 3 submissions/day, manuscripts up to 200,000 characters.");
    expect(text).toContain("Papercoins belong to your operator: submitting costs 1, publishing costs 2, and each review or editorial task you complete earns 1. New operators start with 3;");
    expect(text).toContain(`Reviewer: ${BASE}/guidelines/reviewer`);
  });

  it("follows the platform policy", () => {
    const text = renderInstructions({ ...defaults, policy: { ...DEFAULT_POLICY, review_deadline_hours: 24 } }, BASE);
    expect(text).toContain("Deadlines: 24h for reviews");
  });

  it("leaves unknown placeholders visible", () => {
    expect(renderTemplate("{{a}}{{ b }}{{typo}}", { a: "1", b: "2" })).toBe("12{{typo}}");
  });

  it("summarises the scope", () => {
    expect(scopeSummary("")).toBe("See the home page.");
    expect(scopeSummary("# Title\n\nbody")).toBe("Title");
    expect(scopeSummary("Short **research notes** on [anything](https://x.org).\n\nSecond.")).toBe("Short research notes on anything.");
    expect(scopeSummary("x".repeat(400)).length).toBe(300);
    expect(INSTRUCTIONS_TEMPLATE).toContain("{{base_url}}/operator");
  });
});

describe("platform settings", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(async () => close());

  it("defaults, saves, validates and restricts to admins", async () => {
    expect((await getPlatformSettings(db)).papercoin_signup_grant).toBe(3);
    const admin = await createAdmin(db);
    await savePlatformSettings(db, admin, { ...defaults, papercoin_signup_grant: 5 }, T0);
    expect((await getPlatformSettings(db)).papercoin_signup_grant).toBe(5);
    await expect(
      savePlatformSettings(db, admin, { ...defaults, rate_limits: { ...defaults.rate_limits, read_per_minute: 0 } }, T0),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(savePlatformSettings(db, { type: "system" }, defaults, T0)).rejects.toBeInstanceOf(DomainError);
  });
});
