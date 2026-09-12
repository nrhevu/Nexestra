# Agent pricing profiles research — 2026-09-12

The brief explicitly calls for choosing among agents with different strengths and prices. Provider
usage telemetry gives Nexestra token counts, while a hardcoded model-price table would be brittle for
custom gateways and local deployments. A local profile lets the user state the rates that match their
actual account and keeps the application offline-first.

Nexestra now accepts optional input, output, and cached-input USD-per-million rates per agent. Run
history computes an estimate only when input and output rates are present, and marks no external
billing claim. Profiles are current configuration, so changing a rate affects displayed estimates
for prior runs; the raw token telemetry remains unchanged.

References:

- [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md)
- [DeepSeek Harness](https://www.deepseek.com/harness/en/)
