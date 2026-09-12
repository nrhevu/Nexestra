# ADR 0054 — Message quality feedback

## Status

Accepted.

## Context

Nexestra helps users debate and turn useful agent work into durable Knowledge. Capturing a message
alone does not record whether an answer was useful, so the user cannot build a quality signal to
identify or reduce AI slop.

## Decision

The user can mark an agent message as helpful or needing work. One feedback record is kept per
`threadId` and `messageId` in `state.json`; choosing the same value again clears it, and an API client
may also supply a bounded note. The thread history and full thread-data responses expose feedback
for the messages they contain, and the transcript remains unchanged and append-only. Workspace
exports include feedback records alongside other workspace metadata.

The UI renders keyboard-accessible thumbs-up and thumbs-down controls only for agent-authored
messages. A failed write leaves the current selection unchanged and reports the error through the
existing app error surface.

## Limits

Feedback is a single-user explicit signal. It is not an automatic evaluator and does not alter agent
prompts or routing. Run history may aggregate the counts with exact provenance, but the product does
not reduce them to a quality score or cost-adjusted ranking; see [ADR 0055](0055-run-quality-attribution.md).
