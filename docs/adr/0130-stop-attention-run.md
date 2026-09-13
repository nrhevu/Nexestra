# ADR 0130: Stop pending runs from Needs attention

- Status: Accepted
- Date: 2026-09-13

## Context

Needs attention already lists Master runs waiting for approval or input, but stopping one required
navigating back to the thread. The same endpoint can safely provide a direct intervention when its
run identity is scoped to the selected workspace.

## Decision

Approval and input attention rows show a busy-aware **Stop run** action. The browser sends the run
ID with the selected workspace ID, refreshes workspace metadata, and reports the result through the
existing flash/error surface. Task failure, interruption, and Worker assignment rows remain
Taskboard interventions.

The stop endpoint accepts an optional `workspaceId` guard. When supplied, the dispatcher checks the
run's thread workspace before changing state. Worker assignment IDs continue to be rejected by the
normal Taskboard-only stop rule, and callers without the query parameter retain compatibility.

## Consequences

Users can release a waiting Master run without leaving Needs attention. A foreign workspace cannot
stop a run by replaying a visible ID, while existing thread-level stop behavior remains unchanged.
