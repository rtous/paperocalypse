import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { journals } from "@/lib/db/schema";
import type { Db } from "@/lib/db/types";
import { DomainError } from "@/lib/domain/errors";
import { DEFAULT_INSTRUCTIONS_TEMPLATE, renderInstructions, renderTemplate, scopeSummary } from "@/lib/domain/instructions";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { getPlatformSettings, platformSettingsSchema, savePlatformSettings } from "@/lib/domain/settings";
import { createTestDb } from "./helpers/db";
import { T0, createAdmin } from "./helpers/fixtures";

const journal = (policy = {}, extra: Partial<typeof journals.$inferSelect> = {}) =>
  ({
    id: "j1",
    slug: "synth",
    name: "Journal of Synthetic Inquiry",
    tagline: "",
    scopeMd: "Short **research notes** on [anything](https://x.org).\n\nSecond paragraph.",
    authorGuidelinesMd: "",
    reviewerGuidelinesMd: "",
    editorGuidelinesMd: "",
    agentInstructionsTemplateMd: null,
    status: "open",
    policy: { ...DEFAULT_POLICY, ...policy },
    lastArticleNo: 0,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  }) as typeof journals.$inferSelect;

const defaults = platformSettingsSchema.parse({});
const BASE = "https://p.example";

describe("agent instructions", () => {
  it("fills every placeholder in the default template", () => {
    const text = renderInstructions(journal(), defaults, BASE);
    expect(text).not.toMatch(/\{\{/);
    expect(text).toContain("Contributing to Journal of Synthetic Inquiry with your AI agent");
    expect(text).toContain("Scope: Short research notes on anything.");
    expect(text).toContain(`MCP endpoint (Streamable HTTP): ${BASE}/api/j/synth/mcp`);
    expect(text).toContain(`claude mcp add --transport http synth ${BASE}/api/j/synth/mcp --header "Authorization: Bearer <YOUR_API_KEY>"`);
    expect(text).toContain("Call register_agent on the identity endpoint");
    expect(text).toContain("(required by this journal)");
    expect(text).toContain("Deadlines: 168h for reviews, 336h for revisions.");
    expect(text).toContain("Limits: 3 submissions/day, manuscripts up to 200,000 characters.");
    expect(text).toContain(`Reviewer: ${BASE}/j/synth/guidelines/reviewer`);
  });

  it("adapts to registration mode and operator requirement", () => {
    expect(renderInstructions(journal({ registration_mode: "invite_code" }), defaults, BASE)).toContain(
      "(author and/or reviewer) and the invite_code you received",
    );
    expect(renderInstructions(journal({ registration_mode: "admin_approval" }), defaults, BASE)).toContain("approved by the journal admins");
    expect(renderInstructions(journal({ require_operator_contact: false }), defaults, BASE)).toContain(
      "optionally the name and contact",
    );
  });

  it("shows the admin message when self-registration is off", () => {
    const closed = { ...defaults, register_agent_enabled: false, registration_closed_message: "Email keys@example.org for a key." };
    const text = renderInstructions(journal(), closed, BASE);
    expect(text).toContain("Email keys@example.org for a key.");
    expect(text).not.toContain("Call register_agent");
  });

  it("uses a custom template and leaves unknown placeholders visible", () => {
    const text = renderInstructions(journal({}, { agentInstructionsTemplateMd: "Hi {{journal_name}} {{ slug }} {{typo}}" }), defaults, BASE);
    expect(text).toBe("Hi Journal of Synthetic Inquiry synth {{typo}}");
    expect(renderTemplate("{{a}}{{b}}", { a: "1" })).toBe("1{{b}}");
  });

  it("summarises the scope", () => {
    expect(scopeSummary("")).toBe("See the journal page.");
    expect(scopeSummary("# Title\n\nbody")).toBe("Title");
    expect(scopeSummary("x".repeat(400)).length).toBe(300);
    expect(DEFAULT_INSTRUCTIONS_TEMPLATE).toContain("{{identity_step}}");
  });
});

describe("platform settings", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(async () => close());

  it("defaults, saves, validates and restricts to admins", async () => {
    expect((await getPlatformSettings(db)).register_agent_enabled).toBe(true);
    const admin = await createAdmin(db);
    await savePlatformSettings(db, admin, { ...defaults, register_agent_enabled: false }, T0);
    expect((await getPlatformSettings(db)).register_agent_enabled).toBe(false);
    await expect(
      savePlatformSettings(db, admin, { ...defaults, rate_limits: { ...defaults.rate_limits, read_per_minute: 0 } }, T0),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(savePlatformSettings(db, { type: "system" }, defaults, T0)).rejects.toBeInstanceOf(DomainError);
  });
});
