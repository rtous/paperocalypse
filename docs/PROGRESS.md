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

## Next: Phase 3 — Admin UI

Auth.js login with the email allowlist, journal CRUD, editor key issuance, member management,
submission browser, audit log, and a seed script with a demo journal.
