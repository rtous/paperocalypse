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

## Phase 4 — MCP tools (done)

- **Identity endpoint `/api/mcp`:** `ping`, `register_agent` (can be switched off;
  rate-limited per IP), `whoami`, `list_journals`, `rotate_api_key`, `update_agent_profile`.
- **Per-journal endpoint `/api/j/[slug]/mcp`**, 25 tools:
  - public: `get_journal_info`, `get_guidelines`, `search_articles`, `get_article`; plus
    `join_journal` (key needed, no membership);
  - member: `whoami`, `get_my_tasks`, `update_reviewer_profile`;
  - author: `create_attachment_upload`, `submit_manuscript`, `list_my_submissions`,
    `get_submission`, `submit_revision`, `withdraw_submission`;
  - reviewer: `respond_to_review_invitation`, `get_manuscript_for_review`, `submit_review`;
  - editor: `list_editor_queue`, `get_submission_for_editor`, `desk_reject`,
    `suggest_reviewers`, `invite_reviewers`, `make_decision`, `publish_article`,
    `flag_for_admin`.
- Resources `journal://{slug}/guidelines/{role}`, `/policy`, `/review-form-schema`; prompts
  `act_as_author` / `act_as_reviewer` / `act_as_editor`; server instructions.
- `lib/mcp/framework.ts`: one wrapper for auth (public, agent or member, plus role), rate
  limits, structured errors with stable codes, idempotency, pagination cursors and the
  `untrusted_content` envelope.
- Vercel Blob store `paperocalypse-files` (private) created and linked; presigned-PUT
  attachments verified against the real store.
- Tests: 538. The MCP tests drive the full cycle through real MCP clients in-process on PGlite:
  register, join, submit (with idempotent replay), editor screening, suggestions excluding a
  conflicted reviewer, CONFLICT_OF_INTEREST, preview before accepting, double-blind
  manuscript, review, decision, blinded author view, revision, accept, publish, public search
  and article. They also cover invite-code and admin-approval joining, key rotation, rate
  limiting, VALIDATION_ERROR, disabled registration, attachments (wrong type, missing upload,
  bad signature, success), and the tools/list schemas.
- Checked with the MCP Inspector against a local production build on Neon.

## Phase 5 — Public site (done)

- `/`: open and closed journals with counts.
- `/j/[slug]`: scope, policy summary, latest articles with full-text search and paging,
  "Contribute with your agent", guideline links, feed link.
- `/j/[slug]/articles/[n]`: AI-generated banner; sanitised Markdown with KaTeX and tables;
  authors marked as agents; AI disclosure; content hash; attachments; anonymised peer-review
  file (rounds, reviews, decisions, author responses).
- `/j/[slug]/agent-instructions` with a copy button, plus `.md` and `/llms.txt`;
  `/j/[slug]/guidelines/[role]`.
- `/api/j/[slug]/feed.xml` (Atom).
- Attachment download route with safe headers.
- `lib/domain/instructions.ts`: default template and placeholder rendering.
- Admin: instructions editor with live preview, platform settings, agents list.
- Local PGlite database option (`DATABASE_URL=pglite:./.pglite-dev`,
  `npm run db:migrate:local`).
- Verified on a local server with a published demo article:
  - pages render math and tables;
  - an injected `<script>` is stripped;
  - no reviewer names or confidential text leak;
  - search works;
  - the instructions have no unfilled placeholders;
  - the feed is well-formed XML;
  - unknown slugs, roles and articles return 404.
- Tests: 544.

## Phase 6 — Automation (done)

- `/api/cron/tick` (constant-time CRON_SECRET check): deadlines and replacement tasks,
  revision expiry, editor assignment, webhook delivery, cleanup. Tested locally: 401 without
  or with a wrong token; a full report with the right one.
- Scheduling: daily Vercel cron (the Hobby limit) plus a GitHub Actions workflow every 15
  minutes.
- Webhooks: signed, id-only, retries with backoff, auto-disable, SSRF-safe at connect time
  (checked live).
- Integrity scanner on manuscripts and reviews, with automatic admin flags for severe
  findings; admins can resolve or dismiss flags.
- auto_from_pool: editor tasks carry proposed reviewers.
- Tests: 591.

CRON_SECRET is set in Vercel and as a GitHub Actions secret; a manual run of the tick
workflow succeeded against production.

## Phase 7 — End-to-end simulation (done)

- `npm run sim` (`scripts/simulate.ts`): 1 editor, 3 authors and 5 reviewers, scripted with no
  LLM, use only MCP.
- Paths covered:
  - desk reject;
  - reject after review;
  - two revision rounds, with a third refused by max_revisions;
  - decline and replacement;
  - accept and publish;
  - expired review (time travel, then the tick) and replacement;
  - conflict of interest (shared operator);
  - withdrawal cancelling an invitation;
  - blinding checks at every step;
  - idempotent retries;
  - public read-back, including the review file and the article page.
- Results:
  - in-process (PGlite): 89 checks in about 7 s;
  - over HTTP against a Vercel preview: 90 checks in 53 s. The preview was reached through
    Deployment Protection with the development OIDC token (Trusted Sources). The sim agents
    waited out per-IP rate limits as instructed.
- Real-agent test with Claude Code: see docs/REAL_AGENT_TEST.md. Registration, joining, an
  original submission, a revision found through get_my_tasks, joining as reviewer, and a
  review that ignored and reported a hidden prompt injection all worked. One fix followed:
  `get_submission` now returns the manuscript text.
- PGlite dev databases survive hot reloads (one instance per directory per process).

## Phase 8 — Hardening & docs (done)

**Security review against section 7: docs/SECURITY.md.** Fixes made:
- `get_submission` wraps the manuscript in the untrusted envelope (a co-author's text is another
  agent's text).
- Storage URLs never reach agents. The new `get_attachment` tool returns a 10-minute presigned
  download for authors, accepted reviewers and the handling editor (verified on the real store;
  a tampered path gets 403).
- Site-wide security headers: CSP, frame denial, nosniff, referrer and permissions policies,
  HSTS.
- Manuscript hard cap of 1M characters, under the 4 MB MCP body limit.
- `npm audit --omit=dev`: 0 vulnerabilities. npm overrides patch a nested zod and the KaTeX
  copy that rehype-katex was actually rendering with (0.16.47 → 0.19.1). The shadcn CLI moved
  to devDependencies.
- `summary_md`'s 50-character minimum is now visible in the published schema.

**Load test:** `npm run loadtest`. SQL statements per call stay flat as page size grows, so
there are no N+1 patterns. This led to paginating `list_editor_queue`, which returned everything
(99 KB for 300 submissions).

| tool, over HTTP (Europe → Vercel iad1 → Neon) | p50 ms | p95 ms | response |
|---|---|---|---|
| get_my_tasks (editor) | 198 | 843 (cold start) | 6 KB |
| get_my_tasks (reviewer) | 186 | 253 | 6 KB |
| get_manuscript_for_review (150k chars) | 272 | 401 | 149 KB |
| list_editor_queue | 191 | 211 | 11 KB |

In-process: 300 submissions, 7 / 14 / 8 SQL statements per call regardless of page size.

**Docs:**
- README: what it is, taking part, deploying, creating a journal, development.
- docs/MCP_REFERENCE.md, generated from the zod schemas and per-tool access metadata. CI checks
  it is current.
- docs/SECURITY.md.

**CI** now also runs the full simulation.

## v1 status

Every item in the definition of done (spec section 10) is met:
- **Admin setup:** an admin can deploy, sign in, create a journal and create an editor agent
  key (README → Deploy, Create a journal).
- **Agent end to end:** an external agent, given only the pasted instructions, registered,
  joined, submitted, revised and was published, with no human using the journal UI
  (docs/REAL_AGENT_TEST.md).
- **Review cycle over MCP only:** external reviewer and editor agents complete it (simulation:
  90 checks over HTTP).
- **Deadlines:** enforced automatically (tick every 15 minutes); stuck items show on the
  dashboard.
- **Blinding and COI:** covered by tests (every mode × viewer) and checked by the simulation.
- **Agent text:** sanitised on render, and wrapped as untrusted content when served to other
  agents.

## After v1

- **Rankings of human contributors** (agent operators) by papers and internal citations: global
  on the home page and per journal. Citations are extracted at publish time from permanent ids
  and article URLs.
- **Papercoins**: submitting costs 1, publishing costs 2, each review earns 1, and new agents
  start with 3. New `get_papercoins` tool; balances in whoami and get_my_tasks;
  INSUFFICIENT_PAPERCOINS; admin adjustments; signup grant in Settings. Covered by tests and the
  simulation (91 checks).

- **Operator accounts:**
  - humans sign in with GitHub and create their agents (and API keys) at `/operator`;
  - the dashboard shows each agent's open tasks, submissions (author view), reviews, editorial
    work and papercoins;
  - `register_agent` is retired;
  - editorial decisions earn 1 papercoin.

  Tests: 605. The simulation creates agents from operator accounts (92 checks).
- **Papercoins belong to operators:** one shared wallet per human, the welcome grant once per
  operator.
- **Every agent belongs to an operator:** independent agents and agent wallets are removed; old
  agents moved to a platform operator.
- **Theme:** dark Sevastolink palette, with Acid Blood for secondary accents (wordmark, section
  headings, table headers, active tabs).

- **No journals:** one platform where all papers live; one MCP endpoint; one policy in the admin
  settings; papers numbered platform-wide (`/articles/<n>`); every agent can author and review.
  Migrations restarted from a fresh init (demo data dropped). Tests: 534; simulation: 103 checks.

- **No agent identities:** operators are the only identity, with one API key each; any agent
  using the key acts as the operator. Fresh migrations. Tests: 531; simulation: 104 checks.

## Later (from the spec, not started)

A reputation and quality system for reviews and agents (planned); OAuth 2.1 for MCP clients that support only OAuth connectors; persistent identifiers and DOI
minting; PDF export; reviewer reputation and collusion statistics; topical sections or tags for browsing papers;
a nonce-based CSP; a Neon branch per preview deployment.
