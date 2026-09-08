# ADR index — Milestone M9

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-fresh-local-first-agent-chat.md) | Accepted | Fresh local-first agent chat with shared thread logs |
| [0002](0002-permanent-agent-deletion.md) | Accepted | Permanent agent deletion preserves append-only history |
| [0003](0003-workspace-scoped-state.md) | Accepted | Workspace-scoped state with an in-place version 1 migration |
| [0004](0004-activity-aware-refresh.md) | Amended by 0011 | Activity-aware refresh without idle polling |
| [0005](0005-provider-neutral-master-harness.md) | Superseded by 0007 | Provider-neutral Master tools and explicit permissions |
| [0006](0006-complete-master-tool-surface.md) | Accepted | Complete Master tool surface except LSP |
| [0007](0007-master-access-modes.md) | Accepted | Replace per-tool profile permissions with three access modes |
| [0008](0008-thread-artifacts.md) | Accepted | Thread-scoped uploads and indexed artifact references |
| [0009](0009-safe-rich-markdown.md) | Accepted | Safe rich Markdown rendering for thread messages |
| [0010](0010-opencode-compatible-master-semantics.md) | Accepted | Align provider-neutral Master behavior with OpenCode tool semantics |
| [0011](0011-live-agent-activity-streams.md) | Accepted | Stream run phases, tool activity, and response text into the active thread |
| [0012](0012-collapsible-live-reasoning.md) | Accepted | Show runtime-emitted reasoning only while a run is active |
| [0013](0013-repository-knowledge-worker-delegation.md) | Accepted | Store shared knowledge and delegate planned tasks through isolated Git worktrees |
| [0014](0014-task-knowledge-crud-lifecycle.md) | Accepted | Complete Task and Knowledge CRUD while preserving active and historical Worker state |
| [0015](0015-stoppable-worker-processes.md) | Accepted | Stop queued or running Worker processes while retaining interrupted history |
| [0016](0016-bounded-agent-auto-retries.md) | Accepted | Bound automatic retries without resetting the budget for each new run ID |
| [0017](0017-external-task-verification.md) | Accepted | Verify delegated tasks externally and block them when verification fails |
| [0018](0018-canonical-path-containment.md) | Accepted | Compare Master tool paths against canonical workspace and data roots |
| [0019](0019-explicit-worktree-cleanup.md) | Accepted | Remove finished Worker worktrees explicitly without force or branch deletion |
| [0020](0020-retry-blocked-worker-assignments.md) | Accepted | Retry blocked, failed, or interrupted Worker assignments explicitly |
| [0021](0021-delegate-unstarted-tasks-from-process-dialog.md) | Accepted | Delegate unstarted tasks from the Taskboard process dialog |
| [0022](0022-visible-assignment-history.md) | Accepted | Show every task assignment attempt in the process dialog |
| [0023](0023-safe-assignment-branch-cleanup.md) | Accepted | Delete merged assignment branches explicitly without force |
| [0024](0024-workspace-attention-projection.md) | Accepted | Derive workspace attention from current runs and latest task assignments |
| [0027](0027-workspace-rename-and-reorder.md) | Accepted | Rename workspaces and persist an explicit rail order |
| [0028](0028-shared-worker-assignment-lifecycle.md) | Accepted | Share the canonical queued Worker lifecycle between manual and Master delegation |
