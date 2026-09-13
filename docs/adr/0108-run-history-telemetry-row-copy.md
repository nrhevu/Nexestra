# ADR 0108: Copy one bounded Run history telemetry row

- Status: Accepted
- Date: 2026-09-13

## Context

Run history already exposes cost, usage, harness, model, status, and timing data for comparing
heterogeneous agents. Moving one observed run into a local spreadsheet or evaluation note required
exporting the whole loaded page. A row handoff must not expose transcript content or raw provider
errors.

## Decision

Each Run history row exposes **Copy telemetry**. The browser serializes only the bounded fields
already present in the typed `RunHistoryItem`: run identity and status, stable trigger ID, attempt,
timing, optional usage, bounded failure kind, agent label/profile, thread label, optional task title,
and derived cost fields. The payload is a versioned `nexestra.run-telemetry-row` JSON envelope.

Clipboard writes use the browser API when available. If permission is unavailable or rejected, the
same JSON is shown in a read-only textarea for manual copying. The action is page-scoped and read-only;
it never fetches a transcript, includes error text, or changes run state.

## Consequences

- A single run can be handed to an evaluation or pricing worksheet without exporting unrelated rows.
- The payload remains useful for harness comparison while excluding transcript and secret-bearing
  provider details.
- Manual fallback works on local browsers where Clipboard API permission is unavailable.
