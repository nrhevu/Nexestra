# 0030 — Read-only Worker assignment Git review

## Context

Before removing a finished Worker worktree or merging an assignment branch, the user needs a
bounded snapshot of what the Worker actually changed. The historical commit alone is not enough:
the starting point was not recorded, and the worktree may still hold staged or unstaged edits and
untracked files that verify or manual inspection created. Git commands can also execute repository-
configured external drivers, so a review endpoint must not re-run untrusted configuration.

## Decision

`prepareAssignment` captures the worktree start commit (`baseCommit`) immediately after the
worktree is created and before the Worker is invoked. Assignments created before this capture are
explicitly `legacy` and the review is disabled for them instead of guessing a base.

A new read-only `GET /api/assignments/:id/review` endpoint renders tracked, staged, unstaged, and
base-to-worktree change summaries plus a bounded unified patch and an untracked file list from the
assigned Worktree. It never merges, applies, resets, or cleans up. The process dialog exposes it
only on demand; there is no idle polling.

The reviewer compares the canonical store root with the resolved worktree path, Knowledge clone
path, and both Git common-dir paths, and requires the branch and repository identity to match the
assignment. Any configured Git filter (`filter.*`) disables inspection before any diff runs;
external diff, textconv, fsmonitor, askpass, and ssh drivers are neutralized or refused. Revision
arguments always precede `--` so SHA-shaped paths cannot be misread as revisions.

## Consequences and gaps

- The snapshot is not atomic: Git is read only, but a Worker could mutate the worktree while a
  review is rendering. Refresh produces a fresh bounded snapshot.
- Legacy assignments without a recorded base cannot be reviewed.
- Repositories that configure custom Git filters are refused even though modern Git can run
  filters without content conversion; Nexestra deliberately does not audit the driver contents.
- Binary files are listed but not previewed. The patch and file lists are byte-capped with explicit
  truncation state; stored credentials are redacted from paths, patch content, and error text.
- Submodule working trees are never inspected: `diff.submodule=short` shows only the recorded gitlink
  pointer change and `diff.ignoreSubmodules=dirty` excludes dirty nested contents.
- Cleanup, branch deletion, merge, and push remain separate explicit actions. The review exists
  only to inform the user before those actions.

## Validation

Temporary-repository tests cover committed/dirty/untracked views, stable base when shared main
advances, foreign repository and symlink/relative escape rejection, filter fail-closed with a
marker driver, neutralized external-driver/fsmonitor config, patch/list caps, credential
redaction, and pending/missing/cleaned/legacy states.

## Status

Accepted for Milestone M9.
