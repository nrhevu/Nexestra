# 0077 — Show complete-coverage cost per helpful reply

## Status

Accepted

## Decision

Run history derives an optional `estimatedCostPerHelpfulUsd` metric by dividing the filter-scoped
estimated cost by positive feedback count. It is returned only when every matching run has complete
usage and pricing coverage and at least one reply is marked helpful. The value is an estimate from
local pricing profiles, never a billing record or an automated quality score.

## Consequences

Users can compare the approximate cost of producing helpful outcomes across heterogeneous agents.
Missing usage, pricing, or helpful feedback leaves the metric blank rather than implying a complete
comparison. Existing run rows, ratings, and retry behavior are unchanged.
