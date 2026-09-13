# ADR 0132: Cross-workspace activity monitor

- Status: Accepted
- Date: 2026-09-13

## Context

The workspace rail shows compact activity badges, but comparing several workspaces requires
switching one at a time. A dedicated monitor can use the existing count-only activity summary
without exposing cross-workspace transcripts or run details.

## Decision

Add a Monitor surface that lists active and archived workspace names, active-run and attention
counts, and the age of the last summary observation. Active rows link to workspace selection and,
when attention exists, to Needs attention. Archived rows remain visible for orientation but cannot
be opened because archived workspaces are read-only until restored.

The surface consumes `GET /api/activity/summaries`. Each response carries one `observedAt` timestamp
shared by its rows. The endpoint and bootstrap projection remain count-only; no transcript, prompt,
provider error, credential, or run detail crosses the workspace boundary.

## Consequences

Users can triage activity across workspaces from one place while retaining the existing workspace
switch and attention flows. The monitor is read-only and does not create a new mutation or polling
loop.
