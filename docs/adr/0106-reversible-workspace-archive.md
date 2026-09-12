# ADR 0106: Add reversible soft workspace archival

Status: Accepted

## Context

The workspace deletion preflight can identify active work and produce recovery evidence, but
physically moving a workspace spans transcripts, artifacts, Knowledge repositories, worktrees, and
credentials. A failed move could leave state and files inconsistent. Users still need a way to hide
an old workspace without losing its local data.

## Decision

Add an explicit soft archive operation. It requires typing the exact workspace name, refuses the last
active workspace, and rejects active dispatcher runs or queued/running Worker assignments. Under the
store write barrier it atomically marks the workspace `archived: true` in `state.json`; no owned file,
credential, repository, or worktree is moved or deleted. Bootstrap, activity summaries, the active
workspace API, and the rail expose only unarchived workspaces. Settings lists archived workspaces and
can restore one through an atomic state update.

## Consequences

Archiving is reversible and preserves IDs and paths, so restoration is immediate and lossless. The
archived state is metadata rather than a security boundary; direct filesystem access remains local
to the user. Physical trash moves, retention/purge, crash journals, and permanent deletion remain
separate work once credential and worktree ownership semantics are defined.
