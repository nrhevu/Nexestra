# 0002 — Permanent agent deletion preserves append-only history

## Context

Archiving an agent hides it from the active directory but retains its profile, handle, custom
credential and task references. Nexestra also needs an irreversible way to remove that current
configuration without violating the canonical append-only thread history.

## Decision

Expose permanent deletion as `DELETE /api/agents/:id` with an explicit confirmation in the Agent
management surface. Archived profiles remain visible in a separate section so they can also be
deleted. Chat reserves resolved agents before persisting a message, and deletion is rejected while
an agent has a reservation, queued work or a running invocation. A deletion tombstone blocks new
reservations until the profile update finishes.

Deletion removes the profile and its saved custom credential, changes matching task assignees to
unassigned, and permits the handle to be reused. It does not edit thread JSONL files: messages keep
their embedded author name and handle, and historical runs keep their original agent ID. The UI
renders those author snapshots as a generic agent after the profile is gone and does not offer Retry
for a run whose agent no longer exists.

The state and credential files remain independently atomic rather than jointly transactional.
Credential removal is written first, so an interrupted deletion favors removing the secret over
temporarily retaining a fully usable custom-provider profile.

## Consequences

Users can remove agent configuration and secrets without losing discussion history. Current tasks
cannot retain dangling assignee IDs, and in-flight invocations cannot lose their credentials midway.
Deletion is irreversible, while historical records intentionally continue to contain the deleted
agent's public display name and handle.

## Status

Accepted for Milestone M9.
