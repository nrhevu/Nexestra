# 0029 — Explicit safe retry for failed repository clones

## Context

Adding a Git repository clones it into its managed path immediately. A transient failure left the
Knowledge record at status `failed`, and the only recovery was delete-and-recreate, which lost the
record id, `#handle`, source, and creation time and could orphan assignment history references.
Retry needed to reuse the failed path without ever overwriting unknown contents or a ready clone.

## Decision

Failed repository Knowledge cards expose an explicit **Retry clone** action that calls
`POST /api/knowledge/repositories/:id/retry`. The record keeps its id, `#handle`, source, and
creation time; only status, error, and `defaultBranch` change.

A retry clones into a unique `source.retrying-<uuid>` staging sibling under the item root and
publishes with one atomic `rename`. Publication is allowed only when the destination is missing or
empty; POSIX rename replaces a newly appeared empty directory (no contents are lost) and fails,
leaving contents untouched, when a file or non-empty directory appears in between. A pre-existing
git clone or unknown non-empty destination is rejected with a conflict and the failed record is
kept.

An existing git clone at the destination can be adopted on retry only when provenance is confirmed:
`.git` is a real directory (linked-worktree `.git` files and nested pointers are rejected), the
destination is canonically inside the managed store root and equals the record path, and
`remote.origin.url` exactly matches the record's normalized source. Origin comparison is exact, so
a manually placed clone with an equivalent but differently normalized remote is rejected. A valid
clone with a detached HEAD is adopted as ready without a `defaultBranch`.

A per-item in-memory lock rejects concurrent retries, and the `cloning` state guards edit/delete
during a live retry. On startup, interrupted `cloning` records are inspected and moved to `failed`
with context-specific messages; the state write uses a cloned next state so a failed write rolls
back and leaves the record at `cloning`. A published clone followed by a failed ready-state write is
caught and marked failed, and the next explicit retry safely adopts the published matching clone.

Clone commands run with closed stdin, allowlisted environment variables, a five-minute timeout, and
a two-megabyte output cap. Errors are redacted and truncated so credentials never reach the record
or API response. This slice does not add refresh, fetch, or pull for ready clones, and does not
change source editing or delete-and-recreate behavior.

## Consequences and limits

State and filesystem writes are ordered but not one multi-file transaction. If both the ready write
and the follow-up failed write fail, the record can remain at `cloning` until the next successful
startup recovery; that is a documented persistence outage. A crash mid-clone can leave a
`source.retrying-*` staging directory. Because Nexestra does not yet record ownership of those
directories, they are preserved for manual review rather than auto-removed, including across
restarts and later retries. Restart recovery does not resume a clone; it converts the record to
`failed` and requires another explicit retry. Adoption requires exact origin equality, which is
safer but stricter than Git's own normalization.

## Validation

Tests use only temporary local Git repositories and the fake runner; no live providers or network
are involved. Server tests cover retry after the source becomes available, identity retention,
unknown non-empty destination preservation, foreign clone and linked-worktree rejection, matching
clone adoption, deterministic publication races for a sentinel file and a non-empty directory,
empty-directory replacement scope, duplicate concurrent retry rejection, startup recovery with
rollback, edit blocking during `cloning`, and one-time ready-state persistence failure followed by
adoption. Browser-level acceptance tests cover the failed-to-ready card, usable repository
selection, and delayed retry results after dialog close or workspace switch.

## Status

Accepted for Milestone M9.
