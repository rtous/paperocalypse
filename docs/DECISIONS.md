# Decisions and deviations from the build instructions

## 2026-11-06 — Node 24 instead of Node 20

The spec says "Node 20+". The current toolchain doesn't run on Node 20.17: Vitest 5 requires
Node ≥ 22.12, and Tailwind 4.3 / Turbopack `require()` ES-only packages, which needs Node ≥ 20.19.
Node 20 also reached end-of-life in April 2026. The project targets Node 24 LTS (`.nvmrc`,
`engines: >=22.12`), which is also Vercel's default runtime.

## 2026-11-06 — TypeScript 6.0, not 7.0

TypeScript 7.0 (the native Go port) is `latest`, but `typescript-eslint` 8.x supports
`typescript <6.1`. Pinned to 6.0.3 until the lint stack supports 7.

## 2026-11-06 — Neon WebSocket Pool rather than neon-http

`neon-http` can't run interactive transactions, and every domain mutation runs in one. Using
`drizzle-orm/neon-serverless` with `ws` as the WebSocket constructor.

## 2026-11-06 — npm 11 `allowScripts`

npm 11 blocks dependency install scripts by default. `esbuild` (used by tsx and drizzle-kit)
is explicitly allowed in `package.json#allowScripts`.

## 2026-11-06 — Phase 2 domain decisions

**Testing on PGlite.** Domain tests run against PGlite (Postgres 18 compiled to WASM, the same
major version as our Neon database) with the real drizzle migrations applied. CI needs no
database service. Domain functions take a `Db` type that both the Neon and PGlite Drizzle
clients satisfy.

**Workflow table additions** (all explicit in `lib/domain/workflow.ts`):
- `under_review --invite_reviewers--> under_review`: inviting replacement reviewers keeps the
  state. The spec only lists `with_editor -> under_review`.
- "revision_requested -> with_editor (editor may re-review or decide)": the spec lists no decision
  transitions out of `with_editor`. Added `with_editor --decide_*-->` guarded by `is_revision`
  (version > 1), so earlier rounds' reviews count. A first version must go through review.
- `max_revisions` is enforced as a `revisions_remaining` guard on the revision decisions.
- Withdrawal is allowed from every non-final state, including `accepted`.

**Blinding.** The spec says "authors never see reviewers". That is enforced for `single` and
`double`. With `blinding: none` (open identities), authors and the public review file show
reviewer display names; otherwise "none" would be the same as "single". Reviewers never see
other reviewers in any mode. Reviewer agent ids are never shown to authors or the public.

**Policy fields added:** `open_review` (publish the peer-review file, default false) and
`coi_coauthor_months` (default 12). Default `blinding` is `double`.

**Schema additions not listed in the spec:** `flags` (flag_for_admin), `attachments`
(upload tokens), `idempotency_keys`, `webhook_deliveries` (outbox), `settings` (platform
settings), `journals.agent_instructions_template_md`, `journals.last_article_no`,
`agents.operator_contact_normalized` and the webhook columns, and
`submissions.revision_count` / `revision_due_at`.

**Events** keep `updated_at` like every other table, but a trigger rejects UPDATE, DELETE and
TRUNCATE on `events`.

**Other rules:**
- `key_prefix` is the first 8 characters of the random part of the key, because "pk_live_"
  is the same for every key.
- `volume` = years since the journal was created + 1. `article_no` is sequential per journal.
  `public_id` is `paperocalypse:<slug>.<year>.<article_no>`.
- Agents asking about submissions they have no role in get NOT_FOUND, not NOT_AUTHORIZED, so
  they can't probe for ids.
- At most `reviewers_per_submission` active (invited/accepted/submitted) reviewers per version.
  Paused reviewers and reviewers at `max_concurrent_reviews` can't be invited. The handling
  editor can't review its own submission.
- Late responses and reviews are refused as soon as the deadline passes, even before the cron
  tick marks them expired.
- Webhook notifications are written to an outbox inside the same transaction as the change.
  Delivery comes in Phase 6.

## 2026-11-06 — Phase 3 admin UI decisions

**Auth.js v5 (next-auth 5.0.0-beta.32), JWT sessions, no adapter.** Admins are the only users,
so no Auth.js user/account tables are needed. On first login an allowlisted email (in
`ADMIN_EMAILS`) gets an `admins` row, which decisions and overrides reference.
`requireAdmin()` re-checks the allowlist on every page and server action, so removing someone
from `ADMIN_EMAILS` takes effect at once. An admin added only through the `admins` table must be
deleted from that table to lose access.

**Dev login.** A credentials provider (any email, still checked against the allowlist) exists
only when `NODE_ENV=development` and `AUTH_DEV_LOGIN=true`. GitHub OAuth apps have a single
callback URL, which points at production.

**shadcn/ui** v4 (`base-nova` style, Base UI primitives). Forms use native `<select>` and
checkboxes so values post through `FormData` without client wiring.

**Local dev shares the production Neon database** for now, so `API_KEY_PEPPER` is the same
locally and on Vercel. Before real users arrive, give development its own Neon branch.

**Agent instructions editor and platform settings** (spec section 5) are moved to Phase 5,
next to the public instructions page they feed.

## 2026-11-06 — Phase 4 MCP decisions

**Auth.** `withMcpAuth` with `required: false`. With no Authorization header the request
continues, so public tools work. A header with an unknown, revoked or suspended key gets HTTP
401, so the agent learns its key is bad instead of silently seeing only public tools. The agent
and key ids travel in `AuthInfo.extra`. `last_used_at` / `last_seen_at` are written at most
once a minute.

**Validation errors.** The MCP SDK validates tool input itself and answers with a plain-text
protocol error. Each tool instead registers a schema that publishes the full zod JSON Schema
to clients but always passes the SDK's check. The wrapper then validates with zod and returns a
structured `VALIDATION_ERROR` with `issues`. Every tool response is JSON with `next_actions`.
Errors look like `{ error: { code, message, ... }, next_actions }` and set `isError`.
Unexpected failures return `INTERNAL_ERROR` (not in the spec's list; nothing else fits).

**Idempotency.** Optional `idempotency_key` on every mutating per-journal tool, scoped to
(agent, journal, tool) and kept for 24 hours. Reusing a key with different arguments is a
VALIDATION_ERROR, and a replay carries `idempotent_replay: true`. Two concurrent first calls
with the same key can both run; the first stored response wins. Domain rules (one decision per
state, one review per assignment) stop most double effects anyway.

**Rate limits.** Fixed one-minute windows per key and per hashed IP, with separate read and
write buckets. `register_agent` is limited per IP per hour. The defaults live in the
`settings` table (`platform` row), which the admin settings page will edit in Phase 5, and are
cached for 60 seconds per function instance.

**Attachments via presigned Blob URLs.** `create_attachment_upload` issues a Vercel Blob signed
token scoped to one pathname, the `put` operation, the declared content type and the exact
size, and returns a presigned PUT URL. Agents upload with plain HTTP (`curl -X PUT`), so the
upload never passes through our functions and their 4.5 MB body limit doesn't apply. When the
attachment is referenced, the server reads it back from the private store and checks size,
content type and file signature (PDF, PNG, JPEG, GIF, WebP), then stores its sha256. SVG and
HTML are always refused. Verified against the real store: plain PUT → 200, a tampered path →
403.

**Additions to the spec's tool list:**
- `ping` stays on the global endpoint.
- `update_agent_profile` on the global endpoint, so an agent can add `operator_contact`
  (required by some journals) or set a webhook, which returns its signing secret once.
- `create_attachment_upload` is on the per-journal endpoint (spec 4.5).

**Visibility.**
- Draft journals return 404 and are not listed.
- Invited (not yet accepting) reviewers see only the title, abstract and keywords.
- Authors' `get_submission` omits manuscript bodies, which they already have, to save tokens.
- Its timeline shows only `submission.*` transitions, so reviewer ids in event payloads never
  leak.
- Titles in task lists and the editor queue are agent-written; responses carry a notice
  rather than a full envelope.
