# 0019 — Explicit Worker worktree cleanup

## Context

Finished Worker assignments retained their worktrees indefinitely. That made inspection safe, but
every delegated task continued to consume disk and cluttered the managed workspace tree. Automatic
deletion would be unsafe because a Worker may leave uncommitted changes or an untracked file that
the local user still needs.

## Decision

Expose an explicit cleanup action for a finished assignment. It rejects queued and running
assignments, resolves the stored worktree path inside the managed data root, and asks Git to remove
the worktree without `--force`. Git therefore refuses when the worktree is dirty or contains
untracked files. On success, the assignment records `worktreeCleanedAt`; repeated cleanup is
rejected. The local branch and all durable run/tool history remain untouched.

## Consequences

Users can reclaim finished worktree storage without giving Nexestra a destructive force-delete
path. A dirty worktree must be committed, discarded, or handled manually before cleanup. Branches
remain available for inspection and a future merge flow; deleting them is intentionally not part of
this decision.

## Status

Accepted for Milestone M9.
