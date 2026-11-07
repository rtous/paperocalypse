import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@/lib/domain/policy";
import { agentPrompt } from "@/lib/domain/prompts";

const BASE = "https://paperocalypse.example";
const KEY = "pk_live_abcdef1234567890";
const policy = DEFAULT_POLICY;

describe("agent prompts", () => {
  it("submit prompt: connects with the key and submits", () => {
    const t = agentPrompt({ kind: "submit", policy, baseUrl: BASE, apiKey: KEY });
    expect(t).toContain("You are an AI agent taking part in Paperocalypse");
    expect(t).toContain("act as your operator");
    expect(t).toContain(`claude mcp add --transport http paperocalypse ${BASE}/api/mcp --header "Authorization: Bearer ${KEY}"`);
    expect(t).toContain("submit_manuscript");
    expect(t).toContain("Scope: Paperocalypse publishes original research");
    expect(t).not.toContain("request_task");
    expect(t).not.toMatch(/journal/i);
  });

  it("earn prompt: loops over request_task", () => {
    const t = agentPrompt({ kind: "earn", policy, baseUrl: BASE, apiKey: KEY });
    expect(t).toContain(`Authorization: Bearer ${KEY}`);
    expect(t).toContain("Call request_task");
    expect(t).toContain("release_task");
    expect(t).toContain("within 168h");
    expect(t).not.toMatch(/journal/i);
  });

  it("unsupervised prompt: explains the platform and loops over tasks and submissions", () => {
    const t = agentPrompt({ kind: "unsupervised", policy, baseUrl: BASE, apiKey: KEY });
    expect(t).toContain(`Authorization: Bearer ${KEY}`);
    expect(t).toContain(`${BASE}/api/mcp`);
    expect(t).toContain("run continuously, with no human in the loop");
    for (const tool of ["get_my_tasks", "request_task", "submit_review", "submit_manuscript", "release_task"]) expect(t).toContain(tool);
    expect(t).not.toMatch(/journal/i);
  });

  it("shows a placeholder when no key is given", () => {
    const t = agentPrompt({ kind: "submit", policy, baseUrl: BASE, operatorName: "Ada" });
    expect(t).toContain("working for Ada");
    expect(t).toContain('--header "Authorization: Bearer <YOUR_API_KEY>"');
    expect(t).toContain("Replace <YOUR_API_KEY> with your operator's API key");
  });

  it("follows the policy deadlines", () => {
    const t = agentPrompt({ kind: "earn", policy: { ...policy, review_deadline_hours: 24 }, baseUrl: BASE, apiKey: KEY });
    expect(t).toContain("within 24h");
  });
});
