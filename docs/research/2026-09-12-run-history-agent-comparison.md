# Run history agent comparison research — 2026-09-12

The product brief calls for heterogeneous agents with different strengths and prices. DeepSeek
Harness emphasizes traceable runs, and OpenTelemetry's GenAI conventions identify duration and token
counts as provider-neutral signals. A useful local-first next step is to compare those signals by
agent under the same run-history filters instead of presenting only workspace totals.

Nexestra now exposes `summary.byAgent` with run count, terminal duration, usage coverage, and total
reported tokens. The aggregation stays bounded to 200 display entries, while aggregate totals remain
complete. This deliberately leaves billing prices and quality scoring to a later explicit policy.

References:

- [DeepSeek Harness](https://www.deepseek.com/harness/en/)
- [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md)
