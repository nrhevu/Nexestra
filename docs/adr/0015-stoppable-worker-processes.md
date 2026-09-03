# 0015 — Stoppable Worker processes

## Context

Task process details expose live Worker activity, but a user could not stop a mistaken, blocked, or
unnecessarily expensive assignment. Merely changing Taskboard metadata would leave the underlying
Codex or OpenCode subprocess running and could later overwrite the visible state.

## Decision

Give each delegated assignment an abort controller before it enters the Worker queue. Pass its
signal through repository worktree preparation and Worker invocation. The command runner terminates
the detached process group with `SIGTERM`, then uses `SIGKILL` after the existing grace period if the
process does not exit.

Expose `POST /api/tasks/:id/stop` and a **Stop process** action for queued and running assignments.
Persist the assignment and run as `interrupted`, mark unfinished tool calls interrupted, unassign the
task, and return it to To do. Keep the branch, worktree, transcript, and tool records for inspection.
Interrupted assignments do not prevent a later delegation of the same task.

If persisted state says an assignment is active but no controller exists after restart, the stop
endpoint performs the same state transition without signaling a process. Completion paths check the
abort signal before persisting a result so a stopped Worker cannot subsequently mark itself complete.

## Consequences

Stopping is immediate in the Taskboard and eventually terminates the full CLI process tree. A queued
assignment can be stopped before it creates a worktree. Worktrees partially prepared before a stop
remain managed history and are not automatically removed.

## Status

Accepted for Milestone M9.
