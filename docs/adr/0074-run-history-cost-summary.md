# ADR 0074 — Summarize estimated run cost

## Status

Accepted.

## Context

Run history showed estimated cost on individual rows and in each agent's comparison metrics, but
the filter-scoped summary did not expose a total. A harness operator comparing a workspace, agent,
thread, or status therefore had to add row values manually before deciding which routing was cheaper.

## Decision

The run-history summary and export include an optional `estimatedCostUsd` total derived at read time
from the same usage and local pricing profiles used for rows. `estimatedCostRuns` reports how many
runs contributed to that total. Both values are omitted when no run has a complete estimate; a
partial count makes missing provider telemetry or pricing visible instead of implying a zero-cost
run. The web summary shows the total and its coverage alongside token coverage.

The total is filter-scoped and never persisted to transcripts or treated as an invoice. Existing
per-run and per-agent estimates remain the source of provenance for individual comparisons.

## Limits

Prices remain user-maintained and can change historical estimates. Provider discounts, taxes,
credits, and other invoice adjustments are outside this local telemetry projection.
