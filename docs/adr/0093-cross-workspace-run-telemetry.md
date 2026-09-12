# ADR 0093 — Cross-workspace run telemetry

## Status

Accepted.

## Decision

Expose `GET /api/runs/summary` as a count-only telemetry projection. Without a workspace query it
returns one aggregate per first 200 workspaces; with `workspaceId` it returns only that workspace. Each entry
contains run counts, token totals, local estimated cost coverage, over-budget count, and transcript
coverage. It never returns run rows, messages, tool calls, or provider errors.

The projection delegates to the existing complete run-history summary calculation, so pagination and
cursor semantics remain unchanged. Incomplete transcript coverage is reported explicitly rather than
silently presented as complete spend.

Run history renders the projection as a workspace comparison table when more than one workspace is
available. A failed comparison read leaves the local paged history usable and does not replace it with
partial rows.
