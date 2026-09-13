# ADR 0131: Bulk stop pending runs from Needs attention

- Status: Accepted
- Date: 2026-09-13

## Context

Needs attention can contain several approval or input Master runs at once. Stopping each row
individually is slow and makes it harder to clear a burst of stale decisions.

## Decision

Attention rows for active approval/input runs expose checkboxes and a **Stop selected** action.
The browser sends selected runs sequentially through the workspace-guarded stop endpoint and then
performs one workspace refresh. A busy lock prevents duplicate submissions. The callback returns
failed run IDs; successful selections clear while failed rows remain selected for retry. Task and
Worker assignment rows cannot be selected.

## Consequences

Several waiting Master runs can be cleared in one deliberate action while preserving per-run
ordering and partial-failure visibility. This remains an intervention on live runs and does not
create durable plan approval state.
