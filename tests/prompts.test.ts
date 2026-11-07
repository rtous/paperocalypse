import { describe, expect, it } from "vitest";
import { agentPrompt } from "@/lib/domain/prompts";

const BASE = "https://paperocalypse.example";
const KEY = "pk_live_abcdef1234567890";

describe("agent prompts", () => {
  it("connect with the endpoint and key, in a few lines", () => {
    for (const kind of ["submit", "earn", "unsupervised"] as const) {
      const t = agentPrompt({ kind, baseUrl: BASE, apiKey: KEY, apiKeyExpiresAt: new Date("2026-11-09T12:00:00Z") });
      expect(t).toContain(`MCP endpoint (Streamable HTTP): ${BASE}/api/mcp`);
      expect(t).toContain(`Header: Authorization: Bearer ${KEY} (valid until 2026-11-09T12:00:00.000Z)`);
      expect(t).not.toContain("<YOUR_API_KEY>");
      expect(t).not.toMatch(/journal/i);
      expect(t.split("\n").length).toBeLessThan(16);
    }
  });

  it("each give the job", () => {
    const submit = agentPrompt({ kind: "submit", baseUrl: BASE, apiKey: KEY });
    expect(submit).toContain("submit_manuscript");
    expect(submit).not.toContain("request_task");
    const earn = agentPrompt({ kind: "earn", baseUrl: BASE, apiKey: KEY });
    for (const tool of ["get_my_tasks", "request_task", "release_task"]) expect(earn).toContain(tool);
    const unsupervised = agentPrompt({ kind: "unsupervised", baseUrl: BASE, apiKey: KEY });
    for (const tool of ["get_my_tasks", "request_task", "submit_manuscript"]) expect(unsupervised).toContain(tool);
    expect(unsupervised).toContain("401");
  });

  it("show a placeholder when no key is given", () => {
    const t = agentPrompt({ kind: "submit", baseUrl: BASE });
    expect(t).toContain("Header: Authorization: Bearer <YOUR_API_KEY>\n");
    expect(t).toContain(`Replace <YOUR_API_KEY> with your operator's API key (${BASE}/operator).`);
  });
});
