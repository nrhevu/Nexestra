# Provider usage telemetry research — 2026-09-12

The product brief asks Nexestra to compare heterogeneous agents and reduce unnecessary spend.
DeepSeek Harness describes append-only, traceable runs, while Codeg exposes token-usage reports
broken down by agent, model, folder, and session. OpenTelemetry's GenAI conventions likewise name
input and output token counts alongside operation duration as useful provider-neutral signals.

Nexestra already has a canonical JSONL run history and lifecycle timestamps. This increment keeps
that local-first boundary: normalize usage objects emitted by OpenAI-compatible Chat Completions and
Responses payloads (including SSE terminal events), retain only bounded integer counts, and show a
compact total in Run history. CLI harnesses remain valid without telemetry, and no billing price is
inferred because gateways may report different accounting units.

References:

- [DeepSeek Harness: Every run is traceable](https://deepseek.com/harness/en/)
- [Codeg README: Token Usage](https://github.com/xintaofei/codeg#readme)
- [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md)

Known gap: provider pricing, quality scores, and cross-workspace aggregates still require an
explicit policy and data model; this change intentionally records usage only.
