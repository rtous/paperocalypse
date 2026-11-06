# Progress

## Phase 1 — Skeleton (done)

- Next.js 16 (App Router, Turbopack), React 19, TypeScript 6 strict, Tailwind 4, Node 24.
- Drizzle ORM + drizzle-kit configured for Neon (`lib/db`, `drizzle.config.ts`); schema is empty
  until Phase 2.
- `.env.example` documents every environment variable.
- GitHub Actions CI: lint, typecheck, test, build.
- Global MCP endpoint `/api/mcp` with a `ping` tool (mcp-handler 2.3.1, MCP SDK 2.4.0).
  - Vitest test drives it through the official MCP client SDK.
  - Verified with the MCP Inspector CLI locally (`next start`) and on production:
    `npx @modelcontextprotocol/inspector --cli https://paperocalypse.vercel.app/api/mcp --transport http --method tools/call --tool-name ping`
- Vercel project `rtous/paperocalypse` created and linked; production at
  https://paperocalypse.vercel.app (deployed with `vercel deploy --prod`).
- docs: ARCHITECTURE.md, DECISIONS.md, this file.

Open items:
- Neon (free plan, `iad1`) is waiting for the account owner to accept Neon's marketplace terms;
  then run `vercel integration add neon --billing-plan free_v3 --meta region=iad1 --meta auth=false --name paperocalypse-db`.
- Git auto-deploys: Vercel couldn't connect the GitHub repo because the Vercel account has no
  GitHub login connection. Add one in Vercel account settings, then `vercel git connect`.

## Phase 2 — Data + domain (done)

- Full Drizzle schema (`lib/db/schema.ts`, 21 tables) and migrations in `drizzle/`:
  `0000_init` plus `0001_events_append_only` (a trigger that rejects UPDATE, DELETE and
  TRUNCATE on events). Applied to the Neon database with `npm run db:migrate`.
- Articles carry a generated, weighted `tsvector` with a GIN index for full-text search.
- `lib/domain/`:
  - `workflow.ts`: explicit transition table, guards, admin override.
  - `coi.ts` / `coi-db.ts`: conflict-of-interest rules (author, shared operator, recent
    co-author).
  - `blinding.ts`: author, reviewer, editor and public-review-file serializers.
  - `submissions.ts`: submit, round-robin editor assignment, desk reject, invite reviewers,
    respond, review (editable until decision), decide, revise, withdraw, publish, admin override.
  - `deadlines.ts`: idempotent, batch-limited expiry of invitations, reviews and revisions,
    plus editor assignment for waiting submissions (the cron tick will call this).
  - `tasks.ts` (inbox, each task names its tool), `events.ts`, `notify.ts` (webhook outbox),
    `agents.ts` (agents, HMAC-hashed API keys, role grants), `policy.ts`, `errors.ts`.
- Tests (511, run on PGlite with real migrations): every state × action × role combination,
  guards, every blinding × viewer combination, COI, full lifecycles (two revision rounds →
  publish, desk reject, reject, withdrawal), deadlines, limits, API keys, append-only events.

## Phase 3 — Admin UI (done)

- Auth.js v5 with GitHub login, limited to `ADMIN_EMAILS` plus the `admins` table. There is also
  a local-only dev login. Unauthenticated `/admin` requests redirect to `/admin/login`.
- Pages under `/admin`:
  - dashboard: journals × submission states, members, stuck items (no editor, overdue
    invitations, reviews and revisions), open flags;
  - journals: create and edit every field and the policy, with Markdown preview, and the
    status flow (draft → open ⇄ closed → archived);
  - members and editors: create editor agents, grant roles, issue and revoke keys (each shown
    once), workload and timeliness, approve or suspend members, suspend agents everywhere,
    create and revoke invite codes (hashed, use-counted, expiring);
  - submissions: filter and search, full detail including confidential reviews and integrity
    flags, event history, assign editor, admin override with a required reason;
  - audit log: filter by action prefix, journal, submission or actor, with paging.
- `lib/markdown.ts`: remark/rehype with GFM, strict sanitization, KaTeX, and
  `rel="nofollow ugc noopener"` on links. Tested against XSS payloads.
- `lib/domain/journals.ts`, `memberships.ts` (invite codes, consumed atomically),
  `admin-queries.ts`, `default-content.ts` (default guidelines).
- `npm run db:seed`: idempotent demo journal `/demo` ("Journal of Synthetic Inquiry", open,
  double-blind, open review) with a "Demo Editor" agent and key. Seeded on Neon.
- Verified locally against Neon: login, allowlist rejection, every admin page, and the seeded
  key verifying. 527 tests.
- Vercel env vars set for production and preview: AUTH_GITHUB_ID/SECRET, AUTH_SECRET,
  API_KEY_PEPPER, CRON_SECRET, ADMIN_EMAILS, PUBLIC_BASE_URL.

## Next: Phase 4 — MCP tools

Identity endpoint (register_agent, whoami, list_journals, rotate_api_key), then per-journal
tools role by role, with the auth wrapper, error codes, idempotency, rate limits,
untrusted-content envelopes, resources and prompts.
