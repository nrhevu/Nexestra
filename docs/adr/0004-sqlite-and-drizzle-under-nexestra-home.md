# 0004 — SQLite + Drizzle under `~/.nexestra`

## Context

A local-first single-user app should not require a database service to be
installed, running and backed up. But it does need transactions: every write
stores a projection row **and** appends an event
([0005](0005-event-sourced-store-with-projections.md)), and the two must never
disagree.

## Decision

`better-sqlite3` in WAL mode with Drizzle for the schema, one file at
`~/.nexestra/nexestra.db`. Artifact bytes (diffs, harness logs, verification
evidence) go to `~/.nexestra/data/`, worktrees to `~/.nexestra/worktrees/`.
`NEXESTRA_HOME` moves the lot.

## Consequences

- `better-sqlite3` is synchronous, so a store command *is* a transaction — no
  await between the row and its event, and no way to interleave.
- Backup is `cp nexestra.db*`; a second checkout is `NEXESTRA_HOME=… pnpm dev`.
- Only `packages/storage` touches SQLite. Everything else goes through
  `NexestraStore`.
- One process owns the file. The approval gate waits on the in-process event
  fan-out, so two servers on one database would not release each other's waiters
  (`docs/orchestrator.md` §9).

## Status

Accepted. Implemented in `packages/storage/src/db.ts`,
`packages/storage/src/paths.ts`, `packages/storage/src/schema.ts`,
`packages/storage/drizzle.config.ts`. PLAN.md §1.4.
