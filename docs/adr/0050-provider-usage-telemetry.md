# ADR 0050 — Provider usage telemetry

## Status

Accepted.

## Context

Nexestra is intended to help users choose an effective and affordable harness. Run history already
records lifecycle events, but custom OpenAI-compatible providers' token counts were discarded. That
made cost comparisons depend on a provider dashboard rather than the local run trace.

## Decision

Capture optional provider-reported input, output, total, and cached-input token counts on the run
record. Chat Completions and Responses payloads, including SSE terminal events, are normalized to the
same shape. Invalid or partial usage objects are ignored. Codex and OpenCode runs remain valid
without usage because their CLIs do not consistently expose it.

Usage is retained in the canonical JSONL run event and returned by run history. The filtered run
history response also reports aggregate token totals and how many matching runs supplied usage, so
users can compare a harness without paging through every row. The UI shows compact totals when
present. Credentials, prompts, and provider payloads are never stored as telemetry.

## Limits

Counts are provider-reported and may be absent or defined differently by a gateway. Nexestra does
not infer billing prices, currency, or quality, and does not treat token counts as an exact charge.
