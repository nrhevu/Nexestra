# ADR 0064 — Capture reviewed responses from the needs-work queue

## Status

Accepted.

## Context

The needs-work queue is where users deliberately inspect low-quality agent replies. After review,
a useful response still required navigating back to the thread before it could be promoted to
Knowledge. That extra hop makes the quality loop easy to abandon.

## Decision

Add a `Capture as Knowledge` action to each review-queue item. The queue passes only the bounded,
redacted source preview and stable message identifiers to the existing review dialog. The dialog
continues to require explicit naming, handle and description edits, and the server captures the
canonical message through `POST /api/knowledge/from-message`; the preview is never treated as the
document body. No automatic capture occurs when a review is resolved.

## Consequences

Users can move a reviewed response into Knowledge without losing source provenance or opening a
second surface. Queue previews remain bounded and may be shortened, while the server-side capture
path remains authoritative. Evaluation datasets, corrected-answer editing and automatic promotion
remain separate follow-up decisions.
