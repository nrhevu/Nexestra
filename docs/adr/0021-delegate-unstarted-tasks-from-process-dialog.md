# 0021 — Delegate unstarted tasks from the process dialog

## Context

A Master could create durable Taskboard tasks but stop before delegating one. The process dialog
reported that state, but the local user had to return to chat and re-mention a Master or remember
the Worker and `#repository` handles to start the work.

## Decision

When a task has no assignment, show a delegation form directly in its process dialog. It lists only
enabled, unarchived Workers and ready repositories from the same workspace, defaults to the first
available pair, and calls the existing task delegation endpoint. A task without a linked thread is
shown explicitly and cannot be submitted. Delegation creates the same durable assignment, branch,
worktree, run, and verification contract as Master or manual delegation.

## Consequences

The Taskboard becomes a complete control surface for planned work: a task can be created, delegated,
observed, verified, blocked, retried, and cleaned up without returning to chat. The form does not
create Workers or repositories; it only selects existing ready resources, so setup remains explicit.

## Status

Accepted for Milestone M9.
