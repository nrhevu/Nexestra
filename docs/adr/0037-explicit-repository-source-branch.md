
# 0037 — Explicit repository source branch selection

## Context

Ready repository Knowledge records the clone default branch but refresh has always followed that
default. A repository may want future Worker assignments to run from a release or feature branch
without editing the clone checkout. Assignment Git review already records each Worker starting
commit, so a new selection can publish a source snapshot independently.

## Decision

The repository record gains optional selectedBranch and optional sourceVersion fields. Legacy
records without sourceVersion behave as version 0. The effective branch is
selectedBranch ?? defaultBranch ?? null; defaultBranch keeps the clone default recorded at
creation time.

GET /api/knowledge/:id/branches lists remote refs/heads with bounded, timeout-controlled
noninteractive Git:

- git ls-remote --quiet --heads --refs --exit-code on the recorded source, 15 s timeout and a
  1 MiB output cap, inheriting the existing allowlisted environment and safe transport config.
- Exit code 2 for an empty source returns branches: [] with truncated false. Other failures raise
  a redacted conflict error without touching state.
- Parser keeps only 40/64-hex commit IDs and refs/heads names, sorts by name, caps rows at 500,
  and tolerates CRLF line endings. Leading-dash, trailing-dot, control, space, U+FFFD, malformed,
  overlong, and credential-bearing names are skipped and set truncated true. Peeled and
  non-head refs are intentionally excluded without marking truncation.
- defaultBranch and the effective selectedBranch are filtered with the same representability and
  redaction rules; an overlong or credential-bearing value returns null and sets truncated true
  rather than failing the whole listing.
- Listing runs the same clone provenance/common-directory guard as fetch, then ls-remote. It does
  not take the mutation lock and never writes refs, HEAD, index, FETCH_HEAD, tags, or worktrees.
  Concurrent private-fetch snapshots do not invalidate the versioned listing snapshot.

POST /api/knowledge/:id/source-branch accepts { branch, expectedSourceVersion }:

- Branch is trimmed to 1..256 chars and validated by git check-ref-format on the literal
  refs/heads/<branch> name; control characters, leading option-like dashes, and credential-bearing
  names are rejected as invalid before any state change.
- The operation runs under the existing per-repository lock and requires status ready and
  refreshing false. expectedSourceVersion must equal the current sourceVersion, otherwise the
  request fails with 409 before mutation.
- refreshing true is persisted first. A failed refresh-state write aborts the request before any
  fetch and leaves memory, disk, and the lock untouched.
- Fetch writes the exact refs/heads/<branch> to a fresh refs/nexestra/source-refresh/<uuid> ref
  with the existing no-tags/no-prune/no-submodule/no-auto-maintenance/no-write-fetch-head
  flags. Only after a successful fetch and commit resolution does publication write selectedBranch,
  sourceCommit, sourceRef, refreshedAt, and sourceVersion + 1 in one atomic state update.
- Failure keeps the previous selectedBranch, sourceCommit, sourceVersion, and refreshedAt,
  records a bounded redacted refreshError, and keeps status ready. Branch absence is visible
  through that error; there is no fallback guessing.

Refresh thereafter follows the effective branch and increments sourceVersion by one only when it
successfully publishes a new snapshot. Clone HEAD, origin refs, index, tags, and every existing
assignment worktree remain unchanged. No merge, push, checkout of the source, or new remote
branch is created. The selected branch must exist at the remote; the server never invokes an
agent or provider.

## Consequences and limits

- sourceVersion is a monotonic selection counter, not a global refresh count. It increments only
  on successful publication; stale expected versions make concurrent selection safe under the
  per-repository lock.
- GET returns the effective selectedBranch, not the raw stored field, so a UI always sees the
  branch that future assignments will use. defaultBranch remains the clone original.
- Git ref names that are representable in the API are capped at 256 characters and 500 list rows.
  Longer names are omitted from listing with truncated true; selection rejects them before fetch.
- Credential filtering uses the existing redactSecrets rule. A short stored credential embedded
  inside a larger word may not be recognized by that rule; full-credential and word-delimited
  cases are covered without adding exemptions.
- Private snapshot refs are never pruned by this feature. Failed-fetch snapshots retain reachability
  as in refresh; cleanup of stale snapshot refs remains a documented gap.
- Listing can race a mutation: it publishes snapshot-versioned metadata and may run while a
  private fetch is writing. If the managed clone provenance fails containment or origin checks,
  listing is refused rather than reading an untrusted Git directory.
- State publication uses write-before-swap; if the successful publish write and the failure-state
  write both fail, the previous commit remains selected but refreshing can stay set until restart
  recovery, matching the documented refresh double-failure limit.

## Validation

Temporary local Git tests cover feature branch selection with a dirty existing Worker worktree,
preserved clone HEAD/index/origin refs and worktree bytes, refresh following the selected branch,
missing and invalid branch preservation, stale version and concurrent refresh/selection
interlocks, read-only bounded listing with malformed and peeled fixture lines, empty source,
credential redaction in rows and metadata, overlong legacy default metadata, legacy sourceVersion
restart defaults, refreshing-write failure with no fetch and lock release, unsafe clone
provenance refusal, and HTTP origin/error mapping. No provider or credentialed remote is invoked.

## Status

Accepted for Milestone M9.

