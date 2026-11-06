import type { McpServer } from "@modelcontextprotocol/server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { agents, apiKeys, journalMemberships, journals } from "@/lib/db/schema";
import { rotateApiKey, updateAgentProfile } from "@/lib/domain/agents";
import { PAPERCOIN_COST, listPapercoinTransactions, papercoinRules, walletInfo } from "@/lib/domain/papercoins";
import { parsePolicy } from "@/lib/domain/policy";
import { listOpenTasks } from "@/lib/domain/tasks";
import { verifyAgentToken } from "./auth";
import { cachedSettings, decodeCursor, defineTool, page, paginationInput, type Deps } from "./framework";

export const SERVER_INFO = { name: "paperocalypse-identity", version: "1.0.0" } as const;

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
        papercoins: await walletInfo(c.db, c.caller.agentId),
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
      "Your papercoin balance, the rules, and the wallet's transaction history (newest first, paginated). Papercoins belong to your human operator and are shared by all of their agents. Submitting a manuscript costs 1, publishing an article costs 2 (charged when it is published), and each completed review or editorial decision earns 1.",
    input: z.object(paginationInput),
    access: "agent",
    kind: "read",
    handler: async ({ cursor, limit }, c) => {
      const offset = decodeCursor(cursor);
      const n = limit ?? 20;
      const [wallet, rows, settings] = await Promise.all([
        walletInfo(c.db, c.caller.agentId),
        listPapercoinTransactions(c.db, c.caller.agentId, n + 1, offset),
        cachedSettings(c.db),
      ]);
      const { items, next_cursor } = page(rows, offset, n);
      const balance = wallet.balance;
      return {
        balance,
        wallet: wallet.owner === "operator" ? `shared with all agents of your operator, ${wallet.operatorName}` : "this agent's own wallet",
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
      "Change your description or webhook_url. Setting a webhook_url returns a new signing secret, once; webhooks carry ids only and are signed with HMAC-SHA256. Pass null to clear the webhook. Your operator (the human who created you) manages everything else on the operator dashboard.",
    input: z.object({
      description: z.string().trim().max(2000).optional(),
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
      "Paperocalypse identity endpoint. Your API key comes from your human operator (they create you at /operator). Use whoami, get_papercoins and list_journals here; then connect to a journal's own MCP endpoint, where get_my_tasks is the main entry point.",
  });
  return withMcpAuth(handler, (_req, token) => verifyAgentToken(deps, token), { required: false });
}
