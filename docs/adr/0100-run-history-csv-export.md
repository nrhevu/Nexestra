# ADR 0100: Export loaded run history as CSV

Status: Accepted

## Context

Run history already offers a typed JSON export for the currently loaded page. Price and harness
comparisons are often easier to review in a spreadsheet, but exporting full transcripts or raw
provider errors would widen the privacy surface and make the export depend on unbounded history.

## Decision

Add a client-only CSV export beside the existing JSON action. It serializes at most the bounded
loaded page and uses stable telemetry columns: run and thread IDs, agent labels, status, attempt,
duration, token usage, estimated cost, budget signal, and timestamps. CSV cells are quoted and
escaped for commas, quotes, and line breaks. Transcript text, task prompt text, and raw errors are
excluded. The filename follows the existing workspace-scoped export convention with a `.csv`
suffix.

## Consequences

Users can open the visible run telemetry in spreadsheet tools without another server read or a new
persistence format. The export is intentionally page-scoped; users must load another page before
exporting it, and the JSON packet remains available when filter, summary, and coverage metadata are
needed. IDs and timestamps remain present for local correlation, while sensitive conversation and
provider error content stays in the canonical app view.
