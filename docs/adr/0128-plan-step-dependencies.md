# ADR 0128: Plan step dependencies

- Status: Accepted
- Date: 2026-09-13

## Context

Master plans currently create independent tasks, so a Worker can be delegated a later step before a
prerequisite finishes. This weakens the plan's ordering contract even though Taskboard already
tracks each task durably.

## Decision

The Master `plan` tool accepts an optional `dependsOn` array on each step. References are one-based
step numbers and are bounded to the plan's 20-step limit; missing, self-referential, duplicate, or
cyclic references are rejected. After all tasks receive IDs, the dispatcher persists those edges as
`dependsOnTaskIds` on the generated Tasks.

The store validates that dependencies point to another task in the same plan and workspace and that
the resulting graph remains acyclic. `delegateFromTask` rejects a task while any prerequisite is not
`done`; after prerequisites finish, the same explicit delegation path succeeds. Plans without
dependencies preserve existing behavior.

Tasks that are still referenced as prerequisites cannot be deleted until those edges are removed,
so a dependent task cannot be left with a dangling blocker.

Taskboard marks todo plan tasks waiting on unfinished prerequisites as dependency-blocked, and shows
a small dependency label on affected cards. This is a scheduling guard, not automatic dispatch or
approval.

## Consequences

Plans can express safe sequencing while retaining explicit user or Master delegation. A blocked
dependency is visible and actionable, and no Worker starts before its prerequisites complete.
