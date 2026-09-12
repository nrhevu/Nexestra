# ADR 0057 — Retry failed runs from Run history

## Status

Accepted.

## Context

Run history is the monitoring surface for work across conversations. A failed or interrupted run
could already be retried from the conversation controls through `POST /api/runs/:id/retry`, but a
user reviewing a workspace-wide list had to navigate away before taking that recovery action.

## Decision

Each failed or interrupted run row exposes a **Retry run** action. The browser uses the existing
server retry command and refreshes the workspace and run-history projection after the request is
accepted. The control is disabled while the list is loading or another retry is in flight. Completed,
queued, and waiting runs remain inspect-only; the server remains authoritative for archived-thread,
stale-attempt, and assignment-state checks.

## Consequences

Recovery is available at the point where failures are compared, without duplicating retry policy in
the UI. A successful retry creates the next durable attempt and returns the user to a refreshed
history view. Errors remain in the existing App error surface. Batch retry, automatic retry policy,
and error-output search remain separate work.
