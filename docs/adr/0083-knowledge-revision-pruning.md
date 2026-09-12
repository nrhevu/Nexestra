# ADR 0083 — Explicit bounded Knowledge revision pruning

## Status

Accepted.

## Decision

Document details expose an explicit action to keep the latest ten revisions. The server accepts a
bounded keep-latest count from 1 through 100, always retaining the current revision and deleting only
older revision files after the metadata update. No automatic pruning runs in the background.

## Consequences

Users can reclaim local storage deliberately while preserving recent history. Pruned revisions and
their pinned bytes cannot be recovered from the document; workspace exports should be made first when
long-term retention matters.
