# ADR 0086 — Live cross-workspace activity refresh

## Status

Accepted.

## Decision

Expose `/api/activity/summaries` with only workspace IDs and active-run/attention counts. The SPA
polls it every five seconds only while any badge is nonzero; idle workspaces make no requests.
