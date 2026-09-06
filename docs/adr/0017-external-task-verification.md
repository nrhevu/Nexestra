# 0017 — External task verification

## Context

Worker delegation marked a task done as soon as the Worker returned text. That made the Worker the
generator and the evaluator of its own work, so a task could appear complete even when its branch
did not build or its acceptance command failed. The Taskboard also had no state for work that was
finished by the Worker but rejected by verification.

## Decision

Give each task an optional verification command owned by the local user through the Taskboard API
and UI. After a Worker finishes, the dispatcher runs that command in the assignment worktree with a
five-minute timeout, a 64 KiB process-output cap, the allowlisted process environment, and the
assignment's abort signal. Exit code zero marks the task done. Any other exit code marks it blocked
and stores the redacted, bounded output and exit code on the assignment.

The Master `plan` tool cannot set or change the verification command. A completed task cannot be
delegated again, while a blocked task can receive a new assignment after its previous assignment is
no longer queued or running. The Taskboard exposes To do, In progress, Blocked, and Done columns and
shows the command, exit code, and output in the Worker process dialog.

## Consequences

Task completion now has an external, machine-checked stopping condition instead of trusting Worker
self-reporting. Verification runs with the local OS user's authority, so it remains an explicit
user-owned contract rather than a model-controlled tool. The command can still inspect or mutate
files outside its worktree; that is consistent with the local single-user threat model but should
stay limited to commands the user trusts. State migrates from version 6 to version 7 by giving
existing tasks an empty verification command.

## Status

Accepted for Milestone M9.
