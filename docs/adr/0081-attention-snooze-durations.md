# ADR 0081 — Bounded attention snooze durations

## Status

Accepted.

## Context

The attention surface initially offered only a one-hour snooze. Long-running reviews sometimes need
more time while still requiring a predictable return.

## Decision

Keep server duration validation bounded to seven days and expose three browser choices: one hour,
four hours, and one day. The existing server-computed expiry and workspace-scoped state remain
unchanged.

## Consequences

Users can defer a known issue for a practical interval without editing task data. No arbitrary client
expiry or unbounded notification retention is introduced.
