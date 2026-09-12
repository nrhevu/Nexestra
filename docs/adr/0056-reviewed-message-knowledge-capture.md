# ADR 0056 — Review a message before Knowledge capture

## Status

Accepted.

## Context

Saving a useful agent reply as Knowledge is the handoff from a transient conversation to durable
workspace context. An immediate one-click capture made it easy to preserve an answer, but it gave
the user no place to verify the source or name the resulting document. That weakens the Knowledge
boundary the product uses to reduce low-value agent prose.

## Decision

The message capture action opens a review dialog. The dialog shows the unchanged source message and
lets the user set the Knowledge name, `#handle`, and a bounded description before submitting the
existing `from-message` command. The server remains authoritative for message identity, redaction,
provenance, and immutable document bytes. The dialog does not silently summarize, rewrite, or
publish a message; saving is an explicit user action.

## Consequences

Users can inspect a reply and give it a durable, searchable name before it enters Knowledge. Source
thread and message IDs remain attached, so the document can be traced back to the conversation.
Capturing still preserves the canonical message exactly; correcting or condensing content remains
an explicit edit after capture. The dialog adds one step to the capture path and does not yet create
a separate evaluation or correction queue from needs-work ratings.
