# ADR 0069 — Export loaded run-history telemetry

## Status

Accepted.

## Context

Run history already reports provider token usage, duration, estimated local cost, and quality
signals by agent. Those values are useful for offline comparison, but the paged view had no way to
carry the exact filtered rows and aggregate context into a spreadsheet or evaluation notebook.
Copying the workspace archive for every comparison is unnecessarily broad and includes unrelated
conversation material.

## Decision

Run history offers an explicit **Export loaded runs** action. It creates a versioned
`nexestra.run-history` JSON envelope in the browser containing the current workspace, active filters,
page cursors, coverage, aggregate summary, and at most 100 currently loaded rows. Rows use the
existing redacted `RunHistoryItem` shape: provider errors and raw credentials are not added to the
packet. Opaque cursors are retained only as pagination provenance; they are not interpreted by the
client.

The export is client-only and does not create a server-side artifact or alter canonical transcripts.
Users load older pages before exporting when they need those rows. Aggregate summary values remain
the server's complete filtered totals, while `items` remains the rows visible in the current page.

## Limits

The packet is a point-in-time view of one page and does not include transcript text or hidden model
tokens. It is not a billing invoice and estimates remain dependent on user-maintained pricing
profiles and provider telemetry coverage.
