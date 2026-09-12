# ADR 0068 — Export loaded review cases

## Status

Accepted

## Context

The Needs-work queue provides a useful human checkpoint, but evaluation or prompt-improvement work
often happens in another local tool. Requiring reviewers to copy each row loses the prompt, response,
feedback note and run provenance that make a case useful.

## Decision

Add an **Export loaded reviews** action to the review surface. The browser serializes the currently
loaded queue projection in a versioned `nexestra.review-cases` JSON envelope. The packet is capped at
200 rows and contains only the queue's bounded, server-redacted fields, including stable prompt,
message, thread, agent, feedback and run identifiers. Pagination remains explicit: older rows must
be loaded before they can be included.

The export is client-only and read-only. It does not scan transcripts, change ratings, create
Knowledge, or upload data. The filename is derived from a sanitized workspace ID and date.

## Consequences

Reviewers can carry a bounded set of grounded cases into offline evaluation or prompt review while
preserving canonical provenance. Exported text inherits the queue's known-credential redaction; it
cannot detect secrets unknown to the store's redactor. A larger or automated benchmark export needs a
separate decision.

See the [research note](../research/2026-09-12-review-case-export.md).
