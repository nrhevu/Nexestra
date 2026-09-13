# ADR 0134: Show oldest active and attention age in Monitor

- Status: Accepted
- Date: 2026-09-13

## Context

Count-only cross-workspace monitoring shows where work exists, but it does not show which active
run or pending attention item has been waiting longest. Users therefore have to open each workspace
to choose a triage order.

## Decision

Activity summaries include optional `oldestActiveRunStartedAt` and `oldestAttentionUpdatedAt` ISO
timestamps. The server computes each minimum from existing active-run and attention projections and
returns them alongside the shared observation timestamp. Monitor renders relative "Running since"
and "Waiting since" labels when the corresponding count and timestamp are present.

## Consequences

Monitor can prioritize stale work without fetching transcripts, run details, or secrets from other
workspaces. The fields are optional for compatibility with older fixtures and clients; relative age
is intentionally coarse and is recomputed in the browser from the observation time.
