# 0020 — Retry blocked Worker assignments

## Context

External verification can reject a Worker result, and a Worker assignment can fail or be interrupted.
The Taskboard previously exposed the failure evidence but required the local user to remember the
original Worker handle and `#repository` reference, open the task editor, and manually recreate the
delegation request.

## Decision

Show a **Retry Worker** action in the task process dialog when the latest assignment failed or was
interrupted, or when it completed while external verification blocked the task. The action reuses the
latest assignment's enabled Worker and ready repository, calls the existing task delegation
endpoint, and creates a new assignment, branch, and worktree. Historical assignments, runs, tool
calls, verification output, and cleanup state remain unchanged.

## Consequences

A blocked task becomes a self-correcting loop: the user reviews the verification output and retries
the same Worker without retyping context. Retry is deliberately explicit because it starts a new
process and consumes a new worktree; it is not an automatic retry. If the Worker or repository has
become unavailable, the action is hidden and the existing task editor remains the fallback.

## Status

Accepted for Milestone M9.
