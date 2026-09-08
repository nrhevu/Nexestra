# 0033 — Explicit repository source refresh for future assignments

Amended by [ADR 0037](0037-explicit-repository-source-branch.md): users can select an existing
source branch, refresh follows that selection, and successful publications advance a source version.

## Context

Ready repository Knowledge previously stayed at its clone's original HEAD. Retrying a failed clone
does not update a ready source, and moving the managed clone's checkout could overwrite local edits
or change what an existing Worker is working on. Assignment Git review now records each Worker's
starting commit, so future source selection can advance independently of that history.

## Decision

The ready Knowledge detail view exposes **Refresh source**, backed by
`POST /api/knowledge/repositories/:id/refresh`. It fetches the selected source branch, falling back
to the original default branch before a selection. Each request writes only a new
`refs/nexestra/source-refresh/<uuid>` ref, then
publishes its full commit ID as `sourceCommit`, together with `sourceRef` and `refreshedAt`, in
atomic state metadata. A new worktree reads this selection at the beginning of preparation and
records its actual `baseCommit` before invocation. Before the first successful refresh, preparation
continues to use the clone's HEAD. A caller's earlier repository snapshot cannot silently override
the latest published selection.

Fetch does not update the clone's checkout, index, local branches, tags, origin-tracking refs,
`FETCH_HEAD`, or existing Worker worktrees. Explicit ref mapping, no pruning/tags/submodule recursion,
disabled automatic maintenance and commit-graph writing, and a disabled hooks path enforce that
scope. The managed clone must retain its original source and canonical storage containment; a
foreign Git common directory is refused. SSH and credential access retain the existing clone policy
of using the OS user's Git configuration; Nexestra does not store new credentials.

An in-memory repository operation lock rejects duplicate refresh/retry operations. A persisted
`refreshing` flag guards metadata edits and deletion while the request runs. The repository remains
`ready`: preparations started during fetch use the previous published selection. Success clears the
flag; failure saves a bounded, redacted `refreshError` and retains the last usable selection and
timestamp. Metadata updates use write-before-swap so a failed publication never selects the new
commit only in memory. Restart clears interrupted refresh flags with a visible error while keeping
the clone and previous selection usable.

Git runs with closed stdin, an allowlisted environment, a five-minute fetch timeout and a two-MB
output limit. Browser updates are explicit and generation-guarded; no idle polling is added.

## Consequences and limits

- The default branch is the branch recorded when cloning. An upstream rename or detached initial
  clone can use the explicit branch picker from ADR 0037; refresh does not guess another branch.
- A queued assignment selects the latest published commit when its worktree preparation begins,
  which may be later than the delegation request. A running assignment never changes its base.
- Refresh snapshots retain their own refs, including refs from a fetch whose state write failed.
  They keep previous selections reachable; no automatic ref pruning is implemented yet.
- Git refs and state metadata are separate writes. If publication and its failure-state write both
  fail, the previous commit remains selected but `refreshing` can stay set until restart recovery.
- Fetch updates Git object storage and a private ref; it does not synchronize submodule worktrees,
  merge, pull, push, reset, or clean up assignments. Filesystem changes made manually outside the
  application are not transactional with this operation.
- Existing non-forced branch deletion still relies on Git's upstream-or-clone-HEAD merged check.
  Because refresh does not advance clone HEAD, deleting even an unchanged branch from the refreshed
  source can require manually advancing the clone's integration branch first.
- Another idle browser sees refreshed metadata on its next ordinary refresh. The initiating view
  updates immediately, and late results cannot replace data after a workspace generation changes.

## Validation

Temporary local Git tests cover old/new assignments, preservation of dirty clone/index/worktree
content and origin refs, missing upstream branch recovery, duplicate operations, edit/delete
guards, publication and restart write failures, retained selection, hook/configuration controls,
foreign common-directory rejection, error redaction, and HTTP Origin validation. No provider or
credentialed remote is invoked.

## Status

Accepted for Milestone M9.
