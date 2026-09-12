# ADR 0103: Add a read-only workspace deletion preflight

Status: Accepted

## Context

A workspace owns state metadata, canonical thread transcripts, artifacts, Knowledge documents and
repositories, tasks, assignments, attention records, and agent credentials. Deleting it without
checking active work or the last-workspace invariant could strand runs or remove the only usable
workspace. The final destructive transaction also needs rollback semantics that are not yet defined.

## Decision

Expose `GET /api/workspaces/:id/delete/preflight` and a Settings action that displays its result.
The server returns bounded workspace-scoped counts, the number of active dispatcher runs, active
Worker assignments, credential-bearing agents, and an exact workspace-name confirmation phrase.
Deletion is allowed in the plan only when another workspace remains and no active run or assignment
is observed. The endpoint and UI perform no mutation and never expose credential values or IDs.

The preflight is a read-time snapshot. Actual deletion, filesystem tombstones, credential cleanup,
transaction recovery, and post-delete workspace selection remain a separate decision.

## Consequences

Users can see why a workspace is unsafe to delete and what data would be affected before any
irreversible control is introduced. Counts may change immediately after the plan, so a future delete
operation must revalidate under a write barrier. Repository and worktree cleanup still require
explicit recovery and ownership rules.
