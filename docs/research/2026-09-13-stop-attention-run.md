# Stop pending runs from Needs attention research — 2026-09-13

Needs attention is the monitoring surface for decisions that can stall work. Approval and input
items already contain exact `threadId` and `runId` values, so a direct stop control is a small,
high-value intervention that does not require durable plan approval state.

The endpoint should receive the selected workspace ID and compare it with the run's thread before
stopping. The UI must scope the action to approval/input Master runs, show a temporary disabled
state, refresh the selected workspace, and leave Worker assignment failures on Taskboard where
assignment-specific cleanup is available. Existing callers without a workspace query remain valid.
