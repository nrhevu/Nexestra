# ADR 0061 — Resolve needs-work reviews explicitly

## Status

Accepted.

## Context

The Needs-work review queue made negative replies discoverable, but a user had no durable way to
record that a reply had been reviewed. Clearing the rating would erase the quality signal, while
silently treating a visit as complete would make review status unreliable.

## Decision

Store an optional `reviewStatus` on message feedback. New needs-work ratings start `open`; the
review surface can explicitly mark them `resolved` or reopen them. The queue defaults to open items
and can inspect resolved or all items through a bounded status filter. Updating status verifies the
canonical message and its provenance, changes only review metadata, and leaves the rating, note,
transcript, and Knowledge records intact.

## Consequences

Users can close a reviewed item without destroying the underlying signal or promoting agent prose.
Reopening remains available for follow-up. There is still no automatic correction, evaluation-case
export, or prompt/routing mutation; those require separate explicit decisions.
