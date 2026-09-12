# ADR 0058 — Collect context for needs-work feedback

## Status

Accepted.

## Context

Helpful and needs-work ratings make run comparisons measurable, but a bare negative signal does not
explain what should change. The state and API already accepted a bounded, redacted note while the
browser only sent the rating value.

## Decision

Selecting **Mark response needs work** opens a small dialog with an optional 500-character note.
The rating is persisted only when the user submits that dialog; leaving the note blank is allowed.
Helpful ratings remain one click, and selecting an already active rating still clears it. Notes use
the same server redaction and per-message replacement rules as existing feedback.

## Consequences

Run-history quality counts keep their simple positive/negative meaning while the conversation and
export retain actionable context for later review. The note is not treated as an evaluator verdict,
does not alter prompts or routing, and does not automatically promote a correction into Knowledge.
