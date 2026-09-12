# ADR 0073 — Show estimated cost on each run-history row

## Status

Accepted.

## Context

Agent pricing profiles and provider usage telemetry already produce aggregate cost totals by agent.
The run list itself only showed token counts, so comparing a retry or selecting one task for an
offline evaluation required reconstructing the estimate from aggregate data.

## Decision

Run-history items expose an optional `estimatedCostUsd` derived at read time from the row's
provider-reported usage and the current local pricing profile for its agent. The web surface shows
the estimate beside duration and tokens, and the existing run-history export carries the same field.
The value is omitted when usage or a complete input/output price profile is unavailable.

The estimate is never persisted to canonical transcripts and is not treated as a billing invoice.
Existing aggregate metrics remain unchanged; this adds exact task-level provenance for comparison.

## Limits

Provider telemetry may be absent, prices are user-maintained, and pricing-profile edits can change
the estimate for historical rows. Cached-input rates fall back to the regular input rate as before.
