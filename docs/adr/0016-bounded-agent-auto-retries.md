# 0016 — Bounded automatic agent retries

## Context

Agent runtimes can fail because of temporary network, rate-limit, or service errors. Requiring a
manual retry for every transient failure is unnecessary, but a retry counter tied to the run ID is
not a real bound because each retry receives a new ID. Replaying a whole agent turn can also repeat
tool side effects, so automatic recovery must remain deliberately small and auditable.

## Decision

Persist the failed attempt, then retry matching transient failures at most twice with short bounded
backoff. Give every retry a new durable run ID and increment the existing attempt number. Derive the
remaining budget from that monotonic attempt number rather than process-local state keyed by run ID,
so creating a retry cannot reset the limit. Keep the retry inside the same per-agent queue.

Known stored credentials are redacted from every runtime reply before any attempt can append it to
the canonical transcript or save it as an assignment result.

## Consequences

A continuously failing runtime releases its agent queue after three total attempts, and the full
failure history remains available for diagnosis. A later manual retry remains possible, but it does
not reset the automatic retry budget for that attempt lineage. Whole-turn retry has bounded
at-least-once semantics: a runtime that fails after an external side effect may repeat that effect,
so provider request-level retries remain preferable when they can resume the same tool loop.

## Status

Accepted for Milestone M9.
