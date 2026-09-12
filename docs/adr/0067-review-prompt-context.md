# ADR 0067 — Include the triggering prompt in review rows

## Status

Accepted

## Context

The Needs-work queue showed the agent response and the user's feedback note, but not the request that
the response was meant to satisfy. Reviewers had to open the conversation for every item, which made
quality review slower and encouraged judging an answer without its task context.

## Decision

When a reviewed agent message has a durable `triggerMessageId`, the queue reads that canonical message
by its indexed transcript location. If it is a user message in the same thread, the response includes
an optional `prompt` object with its stable ID, creation time, and an 800-character redacted excerpt.
Missing or malformed prompt provenance omits the field while keeping the review row available. The
agent response remains separately bounded and redacted.

## Consequences

Reviewers can assess intent from the queue itself, while the exact source remains available through the
existing deep link. The extra read is bounded to one indexed transcript line per row; no transcript
history or credentials are returned. This is context for human review, not an automatic evaluation
score or prompt rewrite.

See the [research note](../research/2026-09-12-review-prompt-context.md).
