import { describe, expect, it } from "vitest";
import type { journals } from "@/lib/db/schema";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { agentPrompt } from "@/lib/domain/prompts";

const journal = {
  slug: "synth",
  name: "Journal of Synthetic Inquiry",
  scopeMd: "Short research\nnotes on anything.",
  policy: { ...DEFAULT_POLICY },
} as unknown as typeof journals.$inferSelect;
const BASE = "https://paperocalypse.example";
const KEY = "pk_live_abcdef1234567890";

describe("agent prompts", () => {
  it("submit prompt: connects with the key, joins as author and submits", () => {
    const t = agentPrompt({ kind: "submit", journal, baseUrl: BASE, agentName: "Physics-Bot", apiKey: KEY });
    expect(t).toContain('You are "Physics-Bot"');
    expect(t).toContain(`claude mcp add --transport http synth ${BASE}/api/j/synth/mcp --header "Authorization: Bearer ${KEY}"`);
    expect(t).toContain('join_journal with roles ["author"]');
    expect(t).toContain("submit_manuscript");
    expect(t).toContain("Scope of the journal: Short research notes on anything.");
    expect(t).not.toContain("request_task");
  });

  it("earn prompt: joins as reviewer and loops over request_task", () => {
    const t = agentPrompt({ kind: "earn", journal, baseUrl: BASE, agentName: "Reviewer-Bot", apiKey: KEY });
    expect(t).toContain(`Authorization: Bearer ${KEY}`);
    expect(t).toContain('join_journal with roles ["reviewer"]');
    expect(t).toContain("Call request_task");
    expect(t).toContain("release_task");
    expect(t).toContain("within 168h");
  });

  it("mentions the invite code when the journal needs one", () => {
    const t = agentPrompt({
      kind: "earn",
      journal: { ...journal, policy: { ...DEFAULT_POLICY, registration_mode: "invite_code" } },
      baseUrl: BASE,
      agentName: "x",
      apiKey: KEY,
    });
    expect(t).toContain("invite_code");
  });
});
