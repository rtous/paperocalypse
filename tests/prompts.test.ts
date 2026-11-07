import { describe, expect, it } from "vitest";
import { agentPrompt } from "@/lib/domain/prompts";

const BASE = "https://paperocalypse.example";
const KEY = "pk_live_abcdef1234567890";
const RULE = "-".repeat(40);

describe("agent prompts", () => {
  it("are delimited blocks with the connection and the key", () => {
    for (const kind of ["submit", "earn", "unsupervised"] as const) {
      const t = agentPrompt({ kind, baseUrl: BASE, apiKey: KEY, apiKeyExpiresAt: new Date("2026-11-09T12:00:00Z") });
      const lines = t.trim().split("\n");
      expect(lines[0]).toBe(RULE);
      expect(lines[1]).toBe("BEGINNING OF PAPEROCALYPSE INSTRUCTIONS");
      expect(lines[2]).toMatch(/^The following are instructions to /);
      expect(lines.at(-2)).toBe("END OF PAPEROCALYPSE INSTRUCTIONS");
      expect(lines.at(-1)).toBe(RULE);
      expect(t).toContain(`Connection: MCP (Streamable HTTP) at ${BASE}/api/mcp`);
      expect(t).toContain(`Header: Authorization: Bearer ${KEY} (valid until 2026-11-09T12:00:00.000Z)`);
      expect(t).not.toMatch(/journal/i);
    }
  });

  it("explain one kind of action each", () => {
    const submit = agentPrompt({ kind: "submit", baseUrl: BASE, apiKey: KEY });
    expect(submit).toContain("instructions to submit a paper to Paperocalypse");
    for (const tool of ["submit_manuscript", "submit_revision", "get_guidelines"]) expect(submit).toContain(tool);
    expect(submit).not.toContain("request_task");
    const earn = agentPrompt({ kind: "earn", baseUrl: BASE, apiKey: KEY });
    for (const tool of ["get_my_tasks", "request_task", "release_task", "submit_review"]) expect(earn).toContain(tool);
    expect(earn).not.toContain("submit_manuscript");
    const unsupervised = agentPrompt({ kind: "unsupervised", baseUrl: BASE, apiKey: KEY });
    for (const tool of ["get_my_tasks", "request_task", "submit_manuscript"]) expect(unsupervised).toContain(tool);
    expect(unsupervised).toContain("401");
  });

  it("show a placeholder when no key is given", () => {
    const t = agentPrompt({ kind: "submit", baseUrl: BASE });
    expect(t).toContain("Header: Authorization: Bearer <YOUR_API_KEY>\n");
    expect(t).toContain(`<YOUR_API_KEY> stands for the operator's API key (${BASE}/operator).`);
  });
});
