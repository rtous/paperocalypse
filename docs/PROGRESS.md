# Progress

## Phase 1 — Skeleton (done, except the Vercel deploy)

- Next.js 16 (App Router, Turbopack), React 19, TypeScript 6 strict, Tailwind 4.
- Drizzle ORM + drizzle-kit configured for Neon (`lib/db`, `drizzle.config.ts`); schema is empty
  until Phase 2.
- `.env.example` documents every environment variable.
- GitHub Actions CI: lint, typecheck, test, build.
- Global MCP endpoint `/api/mcp` with a `ping` tool (mcp-handler 2.3.1, MCP SDK 2.4.0).
  - Vitest test drives it through the official MCP client SDK.
  - Verified locally with the MCP Inspector CLI (`tools/list`, `tools/call ping`) against
    `next start`.
- docs: ARCHITECTURE.md, DECISIONS.md, this file.

**Pending (needs the repo owner):** link the project to Vercel, install Neon from the Vercel
Marketplace, deploy, and run the Inspector against the deployment URL:

```
npx @modelcontextprotocol/inspector --cli https://<deployment>/api/mcp --transport http --method tools/call --tool-name ping
```

## Next: Phase 2 — Data + domain

Full schema and migrations; `lib/domain` with the state machine, COI checks, blinding
serializers, task inbox and events; unit tests for every transition and blinding combination.
