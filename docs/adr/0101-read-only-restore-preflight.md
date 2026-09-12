# ADR 0101: Add a read-only restore preflight for workspace archives

Status: Accepted

## Context

Workspace exports are integrity-checked snapshots, but Nexestra does not yet import or restore them.
Users need a safe way to understand what a snapshot contains before a future restore workflow can
be designed. A preflight must not mutate `state.json`, transcripts, artifacts, credentials, clones,
or worktrees, and it must not imply that a valid ZIP is restorable.

## Decision

The local browser inspector derives a bounded restore plan after verifying the archive. It reports the
manifest workspace identity, counts for state collections and archived topology, the archive's
`importSupported` flag, and explicit blockers. Path conflicts are marked as unchecked because no
restore target is opened; unsupported paths are rejected by the existing archive parser rather than
accepted into a plan. The user reveals this inventory through an explicit **Plan restore** action.

The plan is informational and deterministic. It performs no server request, file write, state update,
credential access, clone/worktree access, or merge. Mutation, conflict policy, rollback and actual
restore remain separate future decisions.

## Consequences

Users can inspect snapshot scope before manual transfer, while the app preserves its local-first
privacy boundary. A valid archive still reports that import is unsupported, and an unchecked conflict
set cannot be mistaken for a clean restore target. The inventory is bounded to the existing archive
limits and state collection cap.
