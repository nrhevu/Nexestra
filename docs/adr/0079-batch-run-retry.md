# ADR 0079 — Retry selected failed runs from history

## Status

Accepted.

## Context

Run history exposes individual retries, but supervising a batch of failed or interrupted runs
required repeating the same action row by row. That slows recovery after a provider outage while
making it easy to miss one failed attempt.

## Decision

Run-history rows with `failed` or `interrupted` status expose a selection checkbox. A
**Retry selected** action invokes the existing guarded retry callback sequentially in the visible
page order. Selection is cleared when a fresh page loads or all selected retries complete. No new
retry semantics, server endpoint, or automatic policy is introduced; each existing stale-attempt,
archived-thread, and workspace check still runs independently.

## Consequences

Users can recover several visible failures with one deliberate action. Sequential dispatch avoids
creating a client-side burst and preserves the existing per-run ordering. If one retry fails, the
remaining selection stays available for another attempt; the existing error surface reports the
individual failure. Selection is page-scoped and does not include runs on older pages.
