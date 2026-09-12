# ADR 0080 — Workspace attention snooze and dismissal

## Status

Accepted.

## Context

Needs attention is derived from current runs and tasks, so a user reviewing an item had no way to
temporarily defer it without changing the underlying task or run.

## Decision

Persist a small `attentionStates` list in `state.json`, keyed by workspace and derived attention ID.
The attention surface can snooze an item for a bounded duration (one hour in the browser), or dismiss
it. Snoozed items return after expiry. Dismissed items stay hidden until their derived `updatedAt`
changes, which makes a new task attempt or state transition visible again. The server computes expiry,
validates workspace scope, and applies filtering to both bootstrap and activity responses.

## Consequences

Deferral survives reloads and does not mutate task, run, or transcript data. There is no historical
notification log or cross-device synchronization; dismissal is intentionally reversible through a
new underlying update rather than a separate restore control.
