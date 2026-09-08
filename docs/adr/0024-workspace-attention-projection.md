# 0024 — Workspace attention from current activity

## Context

An agent can pause for permission or user input in a thread the user is not viewing. The SPA's
background refresh previously ignored nonempty activity responses and stopped observing other
threads while the selected thread had active work. Task failures were available only by opening
the Taskboard and inspecting individual assignments.

The existing canonical thread log, task metadata, and live dispatcher already contain the state
needed to identify these conditions. A second durable notification history would add recovery
and dismissal semantics without being necessary for the immediate workflow.

## Decision

Add a workspace-scoped attention projection to bootstrap and the lightweight activity endpoint.
Pending approval/input runs produce one item per run. Blocked tasks and tasks whose latest
assignment failed or was interrupted produce at most one item per task. Done tasks and tasks
with a newer active assignment are omitted. A newer successful assignment supersedes historical
failures; an explicitly blocked task remains visible.

Use current metadata and dispatcher state, with no additional transcript reads, persisted fields,
or migration. Return identifiers, display titles, fixed reason text, and timestamps; tool inputs,
credential-bearing output, and partial reasoning are not part of this payload. Explicit unknown
workspace IDs are rejected.
The browser may recover an invalid saved selection once during initial startup by requesting the
default workspace. Explicit workspace switches retain their errors.

Expose **Needs attention** in navigation with a count and direct links to the existing thread or
task process view. Thread rows also show current run status. These navigation actions do not
execute work or grant permission.
If an attention item names a task not yet present in the browser's cached metadata, load that task
by ID before opening the process view and discard the result after a workspace switch.

Keep selected-thread SSE and active-only background polling. Apply nonempty activity snapshots,
observe background runs even while another thread streams, refresh durable workspace metadata
when any observed run ends, and reject delayed responses from an old workspace.

## Consequences

There is one source of truth for each condition. Restarts reuse the existing interruption
recovery: recovered task failures can appear, while questions that no longer have a live waiter
are handled in their thread. Resolved items disappear without a separate acknowledgement step.

The projection deliberately does not implement a historical inbox, read markers, snoozing,
desktop notifications, or cross-workspace monitoring. It does not scan transcript history for
ordinary failed chat turns. An idle browser does not discover work started by a separate client
until its next normal refresh.

## Status

Accepted for Milestone M9. Extends the refresh behavior documented in ADRs 0004 and 0011.
