# 0011 — One git worktree per task

## Context

Several harnesses run in parallel against one repository. Sharing a checkout
means two agents editing the same files, a `git diff` that mixes their work, and
no way to verify one task's changes in isolation.

## Decision

Each task gets a git worktree on its own branch, cut from the workspace's
default branch:

```
branch    nexestra/<threadId>/<taskId>
path      $NEXESTRA_HOME/worktrees/<threadId>/<taskId>
```

`ensureWorktree()` is idempotent, so a resumed or retried task finds the same
tree. `HarnessConfig.worktreePath` / `.branch` override the derived names.

## Consequences

- The diff, the review target and the verification commands are all scoped to
  one task, which is what makes evidence attributable
  ([0016](0016-verification-runs-commands-not-claims.md)).
- Merges are serialised behind a queue and gated by approval
  ([0017](0017-approval-gates-and-budget-rules.md)); a conflict is aborted, not
  forced.
- A workspace must be a git repository — `POST /api/workspaces` rejects anything
  else. That closes PLAN.md §10.3.
- Worktrees accumulate: `recover()` prunes trees no live task claims, but a
  thread that finishes normally leaves its trees behind
  (`docs/ARCHITECTURE.md` §11).

## Status

Accepted. Implemented in `packages/adapters/codex/src/worktree.ts` (the shared
primitives), `packages/orchestrator/src/worktree.ts`,
`apps/server/src/workspace-path.ts`. PLAN.md §1.10, §6.
