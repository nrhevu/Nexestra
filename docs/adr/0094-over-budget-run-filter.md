# ADR 0094 — Over-budget run filter

## Status

Accepted.

## Decision

Run history accepts an optional `cost=over_budget` filter. The server derives the estimate and
per-agent limit from the same local usage projection used for row and summary telemetry, then applies
the filter before keyset pagination. Runs without complete usage and pricing are excluded because
their budget state is unknown.

The filter is encoded into opaque cursors and exported filter metadata, so a cursor cannot be reused
for a different cost selection. `cost=all` remains the default for existing clients and cursors.
