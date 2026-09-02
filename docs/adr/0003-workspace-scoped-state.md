# 0003 — Workspace-scoped state with an in-place version 1 migration

## Context

The original rebuild had one implicit workspace: all threads, agents, and tasks shared global
lists, and agent handles were globally unique. The workspace name in the sidebar was decorative.
Nexestra now needs multiple independently selectable workspaces without moving or rewriting the
canonical thread transcripts that already exist.

## Decision

Persist explicit workspace records in version 2 of `state.json`. Every agent, thread, and task has a
required `workspaceId`. List projections, bootstrap data, handle lookup, thread-slug allocation, and
task reference validation are scoped to that ID. Workspace IDs and entity IDs remain globally
unique, so transcript files can keep the flat `threads/<thread-id>.jsonl` layout. Creating a
workspace atomically adds the workspace metadata and its initial `general` thread.

On startup, version 1 state is migrated to a default workspace named `Nexestra`. The migration adds
that workspace ID to every existing agent, thread, and task and writes version 2 atomically. It does
not change existing entity IDs, credentials, transcript filenames, or transcript contents.

The far-left UI rail lists and creates workspaces. The adjacent sidebar owns Threads, Surfaces, and
Settings. The selected workspace ID is kept in local browser storage; an absent or stale selection
falls back to the first workspace returned by the server.

## Consequences

Two workspaces can use the same agent handle or thread slug without ambiguous dispatch. Mentions
resolve only against agents in the thread's workspace, and tasks cannot link to another workspace's
agent or thread. Existing installations retain all data and history automatically. Workspace
rename, reorder, and deletion remain future lifecycle decisions.

## Status

Accepted for Milestone M9.
