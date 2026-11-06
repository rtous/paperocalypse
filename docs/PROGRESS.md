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

## Next: Phase 2 — Data + domain

Full schema and migrations; `lib/domain` with the state machine, COI checks, blinding
serializers, task inbox and events; unit tests for every transition and blinding combination.
