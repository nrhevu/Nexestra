# ADR 0052 — Run history agent comparison

## Status

Accepted.

## Context

Nexestra can route one request through different Masters or Workers, but run history only exposed
workspace totals. Aggregate totals hide which agent consumed time or provider-reported tokens, so
the surface could not support a useful harness comparison.

## Decision

Each filtered `/api/runs` response includes a bounded `summary.byAgent` list. Every entry reports the
agent ID and redacted display name plus run count, terminal count, terminal duration, usage coverage,
and total reported tokens. The aggregation uses the same complete set of cached summaries as the
workspace totals, so pagination changes the rows shown but not the comparison metrics. Entries are
ordered by run count, then tokens, then display name, and capped at 200 entries; workspace totals
still include every matching run.

The UI renders the breakdown below the aggregate cards and applies the active agent, conversation,
and status filters. Missing historical agents are shown as `Unknown`. No prices or quality scores are
inferred from token counts.

## Limits

The breakdown remains dependent on the run-history coverage report and provider telemetry remains
optional. It does not yet calculate billing costs or quality-adjusted value.
