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

## Consequences

People and agents share stable document and repository context through the canonical thread
message. Concurrent Workers can change the same source repository without sharing an index or
working tree. Taskboard state exposes the durable plan even if the process restarts.

Repository clones and retained worktrees consume disk until lifecycle controls are added. Private
repositories depend on the current OS user's ambient Git/SSH configuration. ChatGPT OAuth Masters
continue to run through Codex CLI and do not yet have the app-native planning and delegation bridge;
the bridge is available to custom OpenAI-compatible Masters.

## Status

Accepted for Milestone M9.
