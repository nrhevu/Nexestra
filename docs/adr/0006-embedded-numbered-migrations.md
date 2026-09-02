# 0006 — Numbered SQL migrations, embedded into TypeScript

## Context

drizzle-kit writes migrations to `packages/storage/drizzle/*.sql` and the
runtime would normally read that directory relative to `import.meta.url`. The
production server ships as a **single esbuild bundle**, where that path does not
exist — so the bundle would start against an unmigrated database.

## Decision

`src/schema.ts` is the source of truth.
`pnpm --filter @nexestra/storage db:generate` runs drizzle-kit into `drizzle/`
**and** then `scripts/embed-migrations.mjs`, which renders the statements into
`src/migrations.ts` as a plain array. The runtime applies that array and records
applied tags in `__nexestra_migrations`. Both the SQL folder and the generated
module are committed.

## Consequences

- Dev (`tsx`), tests and the esbuild bundle apply byte-identical SQL.
- `packages/storage/src/migrations.test.ts` re-reads `drizzle/` and asserts the
  embedded copy still matches, so the two cannot drift silently.
- Migrations are **append-only and numbered** (`0000_init`,
  `0001_task_merge_state`, `0002_master_runtime`). Editing an applied migration
  is never correct; add the next number.
- `src/migrations.ts` carries a "GENERATED — do not edit by hand" header and
  must never be hand-edited.

## Status

Accepted. Implemented in `packages/storage/scripts/embed-migrations.mjs`,
`packages/storage/src/migrations.ts`, `packages/storage/drizzle/`.
`docs/ARCHITECTURE.md` §3.3.
