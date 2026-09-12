# Agent profile labels in run history research

The harness brief calls for heterogeneous-agent orchestration and price, isolation, and tracking
comparisons. Existing run history already aggregates cost, usage, budget signals, and user
feedback, but its agent breakdown only showed a display name. A compact harness/model label makes
those comparisons interpretable without copying provider configuration into telemetry.

The implementation uses the agent's current profile as a read-time projection. Worker agents expose
their `codex` or `opencode` harness and optional model. Master agents expose `custom` and their
configured model regardless of whether the provider is ChatGPT OAuth or a custom endpoint. The
projection is bounded to a small enum and 200-character model label, and model text goes through
the existing secret redaction. Base URLs, provider names, API keys, raw errors, and transcripts stay
outside the response.

This deliberately keeps the change compatible with legacy transcripts and the existing cost and
quality attribution. The tradeoff is that renaming or reconfiguring an agent can relabel older
history rows; immutable per-run profile snapshots would require a separate transcript/index format
decision.
