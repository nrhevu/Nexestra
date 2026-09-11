# 0027 — Workspace rename and persisted rail order

## Context

Workspaces can be created and selected, and every agent, thread, and task is scoped to one
workspace. Names were fixed after creation, the rail order was the creation order, and Settings
only showed local paths and runtime status. The far-left rail is the primary way users recognize
and switch between workspaces, so a misspelled or differently ordered rail forces recreation or
creates ambiguity in a single-user local workflow.

Migration is not helpful: workspace names and rail order are user preferences, not derived data.
The store already serializes every state mutation through one write queue, which makes an explicit
order list safe to validate and persist without a version bump.

## Decision

Add `PATCH /api/workspaces/:id` to rename a workspace. The store updates `name`, re-derives a
unique `slug` from the remaining workspaces, and bumps `updatedAt`. Renaming to the current
name is a no-op.

Add `PUT /api/workspaces/order` to replace the workspace rail order. The request must list every
current workspace ID exactly once. Duplicate or empty payloads are invalid request data; a list
that no longer matches the persisted workspace set is a conflict so a stale client cannot silently
drop a workspace created by another window. The store applies the order through the existing
serialized write queue. `GET /api/workspaces` returns the persisted order so a dialog that
receives a conflict can reload the list without restarting the app.

Settings gains an ordered, accessible workspace list with Move up and Move down buttons labeled
`Move <name> up` or `Move <name> down`, disabled at the edges and while saving, and a rename
form for the selected workspace. The SPA updates its in-memory bootstrap state from the server
reply: the selected workspace ID, active thread transcript, run activities, and attention snapshot
stay unchanged, and no background bootstrap refresh is triggered. A Reload workspace list button
recovers from a stale reorder by re-fetching `GET /api/workspaces` into the dialog and rail.

Workspace deletion is out of scope and remains unsupported.

## Consequences

Rail order and workspace names persist across restarts and are visible to every client.
Reordering is exact-list based, so a concurrent create either lands before the reorder or makes
the stale reorder fail with a reload message rather than losing the workspace metadata. Rename
keeps entity IDs, transcripts, and managed storage paths unchanged, so history remains intact.

The new endpoints extend the workspace lifecycle introduced in ADR 0003. Deletion remains a
future decision with its own data-retention and worktree-cleanup semantics.

## Status

Accepted for Milestone M9.
