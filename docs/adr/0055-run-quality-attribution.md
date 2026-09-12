# ADR 0055 — Attribute message quality to the producing run

## Status

Accepted.

## Context

Nexestra collects explicit helpful or needs-work ratings so users can reduce low-value agent output.
Run history compares agents, but a trigger message can create several runs: retries reuse the
trigger, and a Master and Worker can both reply to a delegated task. Matching a rating by trigger
and agent alone can therefore charge one reply to the wrong attempt.

## Decision

Generated agent messages carry the durable `runId` that produced them. Feedback records retain the
authoring `agentId` and optional `runId` alongside the existing thread and message IDs. The store
validates this provenance against the canonical transcript before persisting a rating.

Run-history metrics aggregate ratings over the complete filtered run set, then expose helpful and
needs-work counts at the workspace and per-agent levels. A rating is counted only when its run ID
matches the exact run and workspace being summarized. Legacy messages without a run ID are mapped
only when their trigger has one unambiguous matching run; ambiguous retries remain visible in the
conversation but are omitted from run comparisons. No automatic quality score, prompt mutation, or
routing change is inferred from these counts.

## Consequences

Retry and multi-agent comparisons are explainable and stable across pagination and restart. The
transcript remains append-only, while provenance adds a small optional field to new messages and
feedback state. Existing v7 state files and transcripts continue to load because all additions are
optional. Ratings on standalone messages without a run remain useful in the thread but cannot be
assigned to run history until an unambiguous run exists.
