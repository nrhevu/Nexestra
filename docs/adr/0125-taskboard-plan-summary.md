# ADR 0125: Taskboard plan summary

- Status: Accepted
- Date: 2026-09-13

## Context

Master planning already records a bounded `planId` and `planTitle` on each generated Task, but
Taskboard only presents those tasks as independent cards. A user needs a quick view of plan
progress without changing the existing explicit delegation semantics.

## Decision

Taskboard derives a read-only plan summary from the selected workspace's tasks and assignments.
Tasks are grouped only when both `planId` and `planTitle` are present, so manually created and
legacy tasks remain ungrouped. Each plan reports total, ready, delegated, queued, running, blocked,
and done counts. Assignment state uses the latest `updatedAt` record for each task. Each task title
in the summary opens the existing process inspection dialog.

The summary is presentation-only. It does not create, assign, dispatch, retry, or mutate tasks,
and it does not introduce approval or pause/resume semantics for Master plans.

## Consequences

Users can scan progress and jump to the same task inspection flow from one bounded surface. The
summary remains workspace-scoped because it is derived from the already selected bootstrap data.
Future plan approval can build on the durable identity, but must add explicit pending-plan state and
pause/resume behavior before changing delegation semantics.
