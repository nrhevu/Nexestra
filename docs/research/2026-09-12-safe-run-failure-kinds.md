# Safe run failure kinds research — 2026-09-12

Run history needs enough signal for recovery without turning an aggregate monitoring endpoint into
a log transport. GitHub's workflow history separates status and attempt navigation from the detailed
run page. OpenTelemetry likewise distinguishes normalized telemetry dimensions from event payloads.
Those patterns support classifying failures in the list and keeping the source error in the canonical
conversation view.

Nexestra now exposes only six bounded failure kinds in Run history. The classifier uses stable words
such as timeout, verification, unavailable, and provider; unknown wording remains unknown. The
original error is never copied into the history projection or browser response, preserving the
existing secret boundary. The row links the user conceptually to the conversation for exact details,
while the existing Retry action handles failed and interrupted states.

References:

- [GitHub workflow run history](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history)
- [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-metrics.md)
