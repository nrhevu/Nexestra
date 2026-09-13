# ADR 0111: Preserve historical agent profile attribution

- Status: Accepted
- Date: 2026-09-13

## Context

Run history compares heterogeneous harnesses and models, but the previous projection resolved
those labels from the agent profile at read time. Editing a profile could therefore relabel an old
Codex or OpenCode run and make a cost or quality comparison historically misleading.

## Decision

When the dispatcher queues a run, it stores bounded, credential-free `harnessSnapshot` and
`modelSnapshot` fields on the run. Run history rows and per-agent aggregates prefer these immutable
labels. Legacy runs without snapshots continue to fall back to the current profile, and deleted
agents remain unlabeled. Snapshots are included in the existing bounded run-history item and export
contracts; provider URLs, credentials, transcripts, and raw failures remain excluded.

## Consequences

- Profile edits no longer change labels for newly dispatched historical runs.
- Active-run projections apply the same credential redaction before returning a snapshot to the browser.
- A single agent can appear in multiple per-agent comparison rows when its profile changed over time.
- Existing data remains readable through the current-profile fallback until rewritten by a future
  migration, which is intentionally not part of this change.
- Pricing estimates still use the current pricing profile because rates have no immutable snapshot yet.
