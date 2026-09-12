# Knowledge revision pruning research — 2026-09-12

Knowledge revisions had no retention control, so repeated replacements could grow local storage
without bound. A bounded explicit prune action keeps recent versions and the current revision while
removing older immutable files. The browser offers keep latest ten; the API bounds caller input to
one through one hundred for future tooling.

Pruning is never automatic and does not alter message provenance. Users retain the existing export
workflow for archival before deleting old bytes. The action uses an expected revision guard to avoid
pruning from a stale dialog after another update.
