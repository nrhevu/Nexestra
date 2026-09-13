# ADR 0113: Filter run history by execution profile

- Status: Accepted
- Date: 2026-09-13

## Context

Run history stores immutable harness and model labels so a profile edit cannot rewrite an old run.
Without filters on those labels, a user comparing Codex, OpenCode, and custom providers must scan
the whole page and cannot bind pagination to one execution profile.

## Decision

`/api/runs` accepts optional `agentHarness` and `agentModel` filters. The store resolves each run's
snapshot, falling back to the current profile for legacy runs, and filters before sorting and
pagination. Cursor payloads bind both labels and reject reuse with a different selection. The
browser exposes bounded harness and loaded model selectors and preserves them in JSON export.

## Consequences

- Heterogeneous execution profiles can be compared without mixing rows.
- Deleted agents remain filterable when their run contains snapshots; legacy deleted runs have no
  profile to match.
- Model filters use the same credential-redacted label returned to the browser.
- Filters are read-time telemetry controls and do not alter transcripts or run state.
