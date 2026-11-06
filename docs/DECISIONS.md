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
