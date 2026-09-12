# ADR 0084 — Page-scoped bulk review resolution

## Status

Accepted.

## Decision

Needs-work review supports selecting visible open rows and marking them reviewed sequentially through
the existing status callback. Selection is page-scoped and cleared whenever filters or a fresh page
load changes. No new server bulk endpoint or automatic resolution policy is introduced.

## Consequences

Reviewers can clear a bounded batch while preserving per-message authorization and error handling.
Rows on older pages remain untouched until explicitly loaded and selected.
