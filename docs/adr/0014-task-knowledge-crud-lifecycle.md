# 0014 — Task and Knowledge CRUD lifecycle

## Context

Taskboard tasks and Knowledge items could be created and viewed in their surfaces, but users could
not correct metadata or remove obsolete records. Deleting repository knowledge or tasks without
considering Worker assignments could also invalidate an active worktree or erase the route used to
inspect completed work.

## Decision

Expose detail, metadata update, and permanent-delete endpoints and controls for Task and Knowledge
records. Task updates include title, description, column, assignee, and linked thread. Knowledge
updates include name, `#handle`, and description; stored document bytes and repository sources stay
immutable and are replaced through delete-and-create.

Reject task deletion while a related Worker assignment is queued or running. Reject repository
deletion while it is cloning or while a related Worker assignment is queued or running. Remove
unused document and repository storage with the metadata. When a repository has assignment history,
remove it from Knowledge but retain the managed clone, branches, worktrees, assignments, and thread
events so completed work remains auditable.

## Consequences

Every Task and Knowledge card now leads to a complete management flow: create, inspect, edit, and
delete. Handles become immediately reusable after deletion, while historical transcript text is not
rewritten. Retained repository storage can become orphaned from the Knowledge surface and continues
to consume disk until a separate worktree-cleanup workflow is implemented.

## Status

Accepted for Milestone M9.
