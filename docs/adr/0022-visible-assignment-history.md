# 0022 — Visible assignment history

## Context

The task process endpoint returned only the latest assignment. After an explicit retry, the previous
branch, verification result, and cleanup state disappeared from the Taskboard process view even
though they remained durable in state and the canonical transcript. That made retry diagnosis depend
on memory or manual Git inspection.

## Decision

Return every assignment for a task, ordered by creation time, alongside the latest assignment, run,
live activity, and tool calls. The process dialog shows an assignment history with attempt number,
branch, status, verification exit code, and whether its worktree was removed. The latest row is
highlighted.

## Consequences

A retry is now auditable from the Taskboard: the user can compare the failed attempt with the current
one without opening the transcript or Git. Historical rows are read-only; cleanup and retry still
operate on the latest assignment. The endpoint response grows with the number of attempts, which is
acceptable because a task is expected to have a small number of explicit retries.

## Status

Accepted for Milestone M9.
