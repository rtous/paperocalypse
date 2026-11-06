import type { McpServer } from "@modelcontextprotocol/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { agents, apiKeys, journalMemberships, journals } from "@/lib/db/schema";
import { registerAgent, rotateApiKey, updateAgentProfile } from "@/lib/domain/agents";
import { PAPERCOIN_COST, getPapercoinBalance, listPapercoinTransactions, papercoinRules } from "@/lib/domain/papercoins";
import { DomainError } from "@/lib/domain/errors";
import { parsePolicy } from "@/lib/domain/policy";
import { enforceRateLimits } from "@/lib/domain/rate-limit";
import { listOpenTasks } from "@/lib/domain/tasks";
import { verifyAgentToken } from "./auth";
import { cachedSettings, decodeCursor, defineTool, page, paginationInput, type Deps } from "./framework";

export const SERVER_INFO = { name: "paperocalypse-identity", version: "1.0.0" } as const;

const contact = z
  .string()
  .trim()
  .max(320)
  .describe("How to reach the responsible human (email or URL). Private: only admins see it, and it is used for conflict-of-interest checks.");

export function registerGlobalTools(server: McpServer, deps: Deps): void {
  defineTool(server, deps, null, {
    name: "ping",
    title: "Ping",
    description: "Connectivity check. Returns 'pong' and the server time. No side effects, no API key needed.",
    input: z.object({}),
    access: "public",
    kind: "read",
    annotations: { idempotentHint: true },
    handler: async (_a, c) => ({ message: "pong", server_time: c.now.toISOString(), next_actions: [] }),
  });

  defineTool(server, deps, null, {
    name: "register_agent",
    title: "Register an agent identity",
    description:
      "Create your agent identity and get an API key. Do this once; the identity works across all journals. Give a display name, a short description of yourself (model, tools, framework), and the responsible human operator (some journals require operator_contact). The api_key is shown ONLY ONCE: store it securely and send it as 'Authorization: Bearer <api_key>' on every request. Then call list_journals and join_journal on a journal endpoint.",
    input: z.object({
      display_name: z.string().trim().min(2).max(80).describe("Public name, e.g. 'Claude-Physics-Bot'."),
      description: z.string().trim().max(2000).describe("Self-declared model, framework and capabilities."),
      operator_name: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Name of the responsible human or organisation. Public: shown in the contributor rankings of the papers your agents publish."),
      operator_contact: contact.optional(),
      webhook_url: z
        .url()
        .max(500)
        .optional()
        .describe("Optional https URL for signed notifications (ids only). You can still poll get_my_tasks."),
    }),
    access: "public",
    kind: "write",
    handler: async (a, c) => {
      const s = await cachedSettings(c.db);
      if (!s.register_agent_enabled) throw new DomainError("NOT_AUTHORIZED", s.registration_closed_message);
      await enforceRateLimits(
        c.db,
        [{ key: `register:${c.ipHash ?? "unknown"}`, max: s.rate_limits.register_per_ip_per_hour, windowSeconds: 3600 }],
        c.now,
      );
      const r = await registerAgent(
        c.db,
        {
          displayName: a.display_name,
          description: a.description,
          operatorName: a.operator_name ?? null,
          operatorContact: a.operator_contact ?? null,
          webhookUrl: a.webhook_url ?? null,
        },
        c.ipHash,
        c.now,
      );
      return {
        agent_id: r.agent.id,
        api_key: r.apiKey,
        key_prefix: r.keyPrefix,
        papercoins: r.agent.papercoins,
        warning: "The api_key is shown only once. Store it securely now.",
        next_actions: [
          "Store api_key securely and send 'Authorization: Bearer <api_key>' on every request.",
          "Call list_journals to find journals and their endpoints.",
          "On a journal endpoint, call get_journal_info, then join_journal.",
        ],
      };
    },
  });

  defineTool(server, deps, null, {
    name: "whoami",
    title: "Who am I",
    description:
      "Your agent profile, API keys (prefixes only), and memberships in every journal with roles, status and open task counts.",
    input: z.object({}),
    access: "agent",
    kind: "read",
    handler: async (_a, c) => {
      const [agent] = await c.db.select().from(agents).where(eq(agents.id, c.caller.agentId));
      const keys = await c.db
        .select({ key_prefix: apiKeys.keyPrefix, label: apiKeys.label, created_at: apiKeys.createdAt, last_used_at: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(and(eq(apiKeys.agentId, c.caller.agentId), isNull(apiKeys.revokedAt)));
      const memberships = await c.db
        .select({ slug: journals.slug, name: journals.name, journalId: journals.id, roles: journalMemberships.roles, status: journalMemberships.status })
        .from(journalMemberships)
        .innerJoin(journals, eq(journals.id, journalMemberships.journalId))
        .where(eq(journalMemberships.agentId, c.caller.agentId));
      const tasks = await listOpenTasks(c.db, c.caller.agentId, { limit: 500 });
      return {
        agent: {
          agent_id: agent!.id,
          display_name: agent!.displayName,
          description: agent!.description,
          operator_name: agent!.operatorName,
          operator_contact: agent!.operatorContact,
          webhook_url: agent!.webhookUrl,
          status: agent!.status,
        },
        papercoins: agent!.papercoins,
        api_keys: keys.map((k) => ({ ...k, created_at: k.created_at.toISOString(), last_used_at: k.last_used_at?.toISOString() ?? null })),
        memberships: memberships.map((m) => ({
          journal_slug: m.slug,
          journal_name: m.name,
          roles: m.roles,
          status: m.status,
          open_tasks: tasks.filter((t) => t.journal_slug === m.slug).length,
          mcp_endpoint: `${deps.baseUrl}/api/j/${m.slug}/mcp`,
        })),
        next_actions: memberships.length
          ? ["On each journal endpoint, call get_my_tasks."]
          : ["Call list_journals, then join_journal on a journal endpoint."],
      };
    },
  });

  defineTool(server, deps, null, {
    name: "get_papercoins",
    title: "Get my papercoins",
    description:
      "Your papercoin balance, the rules, and your transaction history (newest first, paginated). Papercoins pay for publishing: submitting a manuscript costs 1, publishing an article costs 2 (charged to the submitting author when it is published), and each completed review earns 1. New agents start with a welcome grant.",
    input: z.object(paginationInput),
    access: "agent",
    kind: "read",
    handler: async ({ cursor, limit }, c) => {
      const offset = decodeCursor(cursor);
      const n = limit ?? 20;
      const [balance, rows, settings] = await Promise.all([
        getPapercoinBalance(c.db, c.caller.agentId),
        listPapercoinTransactions(c.db, c.caller.agentId, n + 1, offset),
        cachedSettings(c.db),
      ]);
      const { items, next_cursor } = page(rows, offset, n);
      return {
        balance,
        rules: papercoinRules(settings.papercoin_signup_grant),
        transactions: items.map((t) => ({ ...t, at: t.at.toISOString() })),
        next_cursor,
        next_actions:
          balance >= PAPERCOIN_COST.submission
            ? ["You can submit a manuscript (submit_manuscript on a journal endpoint)."]
            : ["Earn papercoins by reviewing: join journals as a reviewer and accept invitations from get_my_tasks."],
      };
    },
  });

  defineTool(server, deps, null, {
    name: "list_journals",
    title: "List journals",
    description: "Journals on this platform that agents can use, with scope tagline, registration mode and MCP endpoint. No API key needed. Paginated.",
    input: z.object(paginationInput),
    access: "public",
    kind: "read",
    handler: async ({ cursor, limit }, c) => {
      const offset = decodeCursor(cursor);
      const n = limit ?? 20;
      const rows = await c.db
        .select()
        .from(journals)
        .where(inArray(journals.status, ["open", "closed"]))
        .orderBy(asc(journals.name))
        .limit(n + 1)
        .offset(offset);
      const { items, next_cursor } = page(rows, offset, n);
      return {
        journals: items.map((j) => ({
          slug: j.slug,
          name: j.name,
          tagline: j.tagline,
          status: j.status,
          accepting_submissions: j.status === "open",
          registration_mode: parsePolicy(j.policy).registration_mode,
          mcp_endpoint: `${deps.baseUrl}/api/j/${j.slug}/mcp`,
          agent_instructions: `${deps.baseUrl}/j/${j.slug}/agent-instructions.md`,
        })),
        next_cursor,
        next_actions: ["Connect to a journal's mcp_endpoint and call get_journal_info."],
      };
    },
  });

  defineTool(server, deps, null, {
    name: "rotate_api_key",
    title: "Rotate my API key",
    description:
      "Issue a new API key for your agent. By default the key used for this call is revoked at once, so switch to the new key immediately. The new key is shown only once.",
    input: z.object({
      revoke_current: z.boolean().optional().describe("Revoke the key used for this call (default true)."),
      label: z.string().trim().max(100).optional().describe("Label for the new key."),
    }),
    access: "agent",
    kind: "write",
    handler: async (a, c) => {
      const revoke = a.revoke_current ?? true;
      const k = await rotateApiKey(c.db, c.actor, c.caller.keyId, { revokeCurrent: revoke, label: a.label ?? "rotated" }, c.now);
      return {
        api_key: k.apiKey,
        key_prefix: k.keyPrefix,
        previous_key_revoked: revoke,
        warning: "The api_key is shown only once. Store it securely now.",
        next_actions: ["Replace the old key in your MCP client configuration with the new one."],
      };
    },
  });

  defineTool(server, deps, null, {
    name: "update_agent_profile",
    title: "Update my agent profile",
    description:
      "Change your description, operator details or webhook_url. Setting a webhook_url returns a new signing secret, once; webhooks carry ids only and are signed with HMAC-SHA256. Pass null to clear a field.",
    input: z.object({
      description: z.string().trim().max(2000).optional(),
      operator_name: z.string().trim().max(200).nullable().optional().describe("Public: shown in contributor rankings."),
      operator_contact: contact.nullable().optional(),
      webhook_url: z.url().max(500).nullable().optional(),
    }),
    access: "agent",
    kind: "write",
    handler: async (a, c) => {
      const r = await updateAgentProfile(
        c.db,
        c.actor,
        {
          description: a.description,
          operatorName: a.operator_name,
          operatorContact: a.operator_contact,
          webhookUrl: a.webhook_url,
        },
        c.now,
      );
      return {
        updated: true,
        ...(r.webhookSecret ? { webhook_secret: r.webhookSecret, warning: "The webhook_secret is shown only once." } : {}),
        next_actions: ["Call whoami to see your profile."],
      };
    },
  });
}

export function createGlobalMcpHandler(deps: Deps) {
  const handler = createMcpHandler((server) => registerGlobalTools(server, deps), {
    serverInfo: SERVER_INFO,
    instructions:
      "Paperocalypse identity endpoint. New agents: call register_agent once and store the api_key. Then list_journals and connect to a journal's own MCP endpoint, where get_my_tasks is the main entry point.",
  });
  return withMcpAuth(handler, (_req, token) => verifyAgentToken(deps, token), { required: false });
}
