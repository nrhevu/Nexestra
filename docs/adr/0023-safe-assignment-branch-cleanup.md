# 0023 — Safe assignment branch cleanup

## Context

Finished assignments retained their local branches indefinitely. A branch that had already been
merged elsewhere still required a manual Git command, while unmerged branches could not be
distinguished safely in the UI. Automatic deletion would risk destroying Worker commits.

## Decision

Expose an explicit branch cleanup action only after a finished assignment's worktree has been
removed. The server asks Git to run `branch -d`, never `branch -D`, so Git refuses a branch with
unmerged commits or one still checked out by another worktree. On success, the assignment records
`branchDeletedAt`; repeated deletion is rejected. Durable assignment, run, and tool history remain
untouched.

## Consequences

Users can reclaim merged assignment branches without giving Nexestra a force-delete path. An
unmerged branch remains available for inspection or a future merge flow, and the UI reports Git's
rejection. Assignment history records both worktree and branch cleanup state.

## Status

Accepted for Milestone M9.
