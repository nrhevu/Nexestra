# ADR 0060 — Provide a bounded needs-work review queue

## Status

Accepted.

## Context

Message ratings gave the user a way to mark an agent response as needs work, but the signal was
only visible in the source conversation and aggregate run history. That made it easy to lose the
human context needed to decide whether a response should be corrected, captured as Knowledge, or
discarded.

## Decision

Expose a workspace-scoped, read-only review queue at `/api/reviews` and in the Needs-work review
surface. It returns only the latest negative rating for each agent message, a bounded 800-character
redacted excerpt, the optional redacted note, and redacted thread and agent labels. Results use a
stable cursor and report transcript coverage. Opening an item deep-links to the canonical message;
the existing Knowledge capture dialog remains the explicit promotion and editing step.

The projection never returns raw run errors, credentials, artifacts, or unbounded transcript text.
It ignores ratings that cannot be verified against the owning workspace and marks unreadable
transcripts in coverage instead of guessing.

## Consequences

Users have a durable place to revisit corrections across conversations while the canonical JSONL
transcript remains authoritative. Queue entries are intentionally not auto-resolved or silently
promoted to Knowledge; a future evaluation workflow can add an explicit resolution state without
changing this read-only projection's safety boundary.
