# 0003 — One TypeScript pnpm monorepo, packages consumed as source

## Context

The server and the browser share the whole domain model: entities, the harness
event union, the REST bodies, the WebSocket frames. Duplicating those types, or
keeping them in sync by hand, is the single easiest way to ship a bug that only
shows up at runtime.

## Decision

One pnpm workspace, TypeScript everywhere, with `@nexestra/core` as the shared
contract. Every internal package points `main` / `types` / `exports` at
`./src/index.ts` — TypeScript source, not build output.

## Consequences

- `apps/web` aliases `@nexestra/*` to the source files, `apps/server` runs under
  `tsx` in dev, and the production server bundle inlines the workspace packages
  with esbuild. There is no per-library build step, so nothing can go stale.
- A type change in `@nexestra/core` breaks `pnpm typecheck` in every consumer
  immediately, which is the point.
- The tests import the same sources the app does, so a test cannot pass against
  a stale build.

## Status

Accepted. Implemented in `pnpm-workspace.yaml`, `tsconfig.base.json`,
`apps/web/vite.config.ts`, `apps/server/scripts/build.mjs`,
`packages/core/src/index.ts`. PLAN.md §1.3, §2.
