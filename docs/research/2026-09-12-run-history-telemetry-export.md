# Run-history telemetry export research — 2026-09-12

The brief's cost and delivery goals need a portable record of what was compared. OpenTelemetry's
GenAI semantic conventions make input and output token counts useful provider-neutral dimensions,
but they do not turn optional telemetry into a billing ledger. A narrow export should therefore
preserve the run-history aggregate and exact visible rows, with active filters and cursor context,
without exporting full transcripts or credentials.

Nexestra now emits a versioned, browser-generated `nexestra.run-history` JSON packet. It is capped at
100 rows, uses the already redacted history projection, and distinguishes the complete server
summary from the currently loaded page. This supports local spreadsheets and evaluation scripts
while preserving pagination and the canonical JSONL boundary.

References:

- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [GitHub Actions run history](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history)
