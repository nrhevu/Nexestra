# ADR 0109: Add a blocked-task custom surface card

- Status: Accepted
- Date: 2026-09-13

## Context

Custom surfaces can show a Taskboard count for all unfinished work, but blocked tasks are the
strongest handoff signal and are otherwise mixed with ordinary todo and in-progress work.

## Decision

Extend the allowlisted `CustomSurfaceAction` enum with `blocked_tasks`. The selected workspace
computes its count from tasks whose status is exactly `blocked`; completed and foreign tasks are
excluded. The card uses the existing Taskboard route, where the user can inspect the full task
context. Configuration remains declarative and cannot execute code or provide arbitrary URLs.

## Consequences

- Domain surfaces can highlight blocked work without a new persistence model or route.
- A zero count is represented as `0 matching items`, preserving an honest signal.
- The Taskboard destination currently shows all tasks; a blocked-only filtered view can be added
  later without changing the allowlisted action contract.
