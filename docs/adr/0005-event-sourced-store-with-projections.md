# 0005 — Event-sourced store with projections

## Context

Four requirements point at the same mechanism: resume after a crash, an audit
trail of what an agent did, cost accounting, and streaming live changes to the
UI. Implementing them separately would mean four places to forget to update.

## Decision

Every write goes through a command on `NexestraStore`, which writes the
projection row **and** appends a `NexestraEvent` in one transaction. Entity
event payloads carry the **full post-state** of the entity, so replay is a plain
upsert. `rebuildProjections(store, threadId)` deletes the thread's rows and
replays its log.

Two deliberate exceptions:

- `master_messages` / `master_state` are written **without** an event. They are
  the Master's private scratch space — the verbatim API content blocks it
  replays into the next request — and nothing projects from them.
- The `master.*` and `orchestrator.*` families narrate a turn or a run so the
  WebSocket can stream it. No projection hangs off them and `rebuildProjections`
  skips them; everything durable those two produce still arrives as an ordinary
  entity event.

## Consequences

- Listeners fire **after** the transaction commits, so a WebSocket client can
  never observe an event whose write was rolled back.
- `seq` is monotonic per thread (per workspace for workspace-scoped events),
  which is what makes `?afterSeq=` reconnection work.
- Text deltas are coalesced into ~80-character chunks before being appended; a
  row per token would multiply the log by two orders of magnitude.
- The log grows and nothing prunes it — a known gap
  (`docs/ARCHITECTURE.md` §11).

## Status

Accepted. Implemented in `packages/core/src/events.ts`,
`packages/storage/src/store.ts`, `packages/storage/src/event-store.ts`,
`packages/storage/src/replay.ts`, proved by
`packages/storage/src/replay.test.ts`. PLAN.md §1.5, §3.
