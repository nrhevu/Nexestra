# 0013 — Repository knowledge and isolated Worker delegation

## Context

Threads need a stable way to refer to repository-wide documents and source repositories without
attaching the same material to every message. Implementation requests also need a durable plan and
isolated Worker execution; running multiple Workers in the application repository would mix
uncommitted files and make ownership unclear.

## Decision

Add a workspace-scoped Knowledge surface with document and Git repository records. Each item has a
unique handle and is referenced from chat as `#handle`. Store uploaded document bytes and cloned
repositories below `.nexestra/workspaces/<workspace-id>/`, and persist stable knowledge references
on each triggering message. Never store credentials embedded in a repository URL.

Add `plan` and `delegate` to the provider-neutral Master harness. `plan` creates Taskboard tasks
linked to the current thread. A Master may delegate only task IDs created by its current tool
session. Delegation selects an enabled Worker and a ready `#repository`, creates a unique
`nexestra/<assignment-id>` branch and Git worktree, and invokes the Worker in task mode with that
worktree as its current directory. Worker queues preserve serial execution per agent.

Workers must verify and commit their changes on the assigned branch. Nexestra records assignment
status and the result but does not merge, push, or remove branches and worktrees automatically.

Treat every assignment as a normal durable Worker run by using the assignment ID as the run ID.
Persist its lifecycle and normalized tool calls in the canonical thread transcript, and retain its
reasoning and partial response only in the bounded live projection. Taskboard cards open a process
view that joins this run data with the assignment and follows the thread event stream while active.

When delegation inputs are available, a custom-provider Master may not finalize while tasks created
by its current `plan` call remain undelegated. A premature final answer becomes a corrective provider
turn instructing the Master to call `delegate` for each remaining task. Missing Workers or a missing
repository reference remain explicit blockers instead of forcing invalid assignments.

## Consequences

People and agents share stable document and repository context through the canonical thread
message. Concurrent Workers can change the same source repository without sharing an index or
working tree. Taskboard state exposes the durable plan even if the process restarts.
Worker activity is visible from the task that owns it, including live phase, emitted reasoning,
streamed text, and durable tool history. The completion guard prevents a successful Master response
from silently leaving assignable planned work in To do.

Repository clones and retained worktrees consume disk until lifecycle controls are added. Private
repositories depend on the current OS user's ambient Git/SSH configuration. ChatGPT OAuth Masters
continue to run through Codex CLI and do not yet have the app-native planning and delegation bridge;
the bridge is available to custom OpenAI-compatible Masters.

## Status

Accepted for Milestone M9.
