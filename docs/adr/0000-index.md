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
| [0025](0025-app-scoped-conversation-state.md) | Accepted | Own drafts and last-thread browser state at the App root |
| [0026](0026-agent-profile-editing.md) | Accepted | Editable agent profiles with write-only credential rotation |
| [0027](0027-workspace-rename-and-reorder.md) | Accepted | Rename workspaces and persist an explicit rail order |
| [0028](0028-shared-worker-assignment-lifecycle.md) | Accepted | Share the canonical queued Worker lifecycle between manual and Master delegation |
| [0029](0029-repository-clone-retry.md) | Accepted | Explicit safe retry for failed repository clones |
| [0030](0030-read-only-assignment-git-review.md) | Accepted | Read-only on-demand Git review of Worker assignment changes before cleanup |
| [0031](0031-thread-rename-and-archive.md) | Accepted | Rename threads and archive or restore them without changing canonical history |
| [0032](0032-revision-history.md) | Accepted | Keep immutable Knowledge document revisions and pin new message references |
| [0033](0033-explicit-repository-source-refresh.md) | Amended by 0037 | Refresh the recorded source branch for future Worker assignments without changing existing worktrees |
| [0034](0034-transcript-message-search.md) | Accepted | Search canonical message content with bounded reads and explicit completeness |
| [0035](0035-message-deep-links.md) | Amended by 0038 | Open stable message links with focused, workspace-aware conversation navigation |
| [0036](0036-knowledge-preview.md) | Accepted | Preview current and historical document text with bounded reads and integrity checks |
| [0037](0037-explicit-repository-source-branch.md) | Accepted | Select an existing source branch for future Workers with version checks and preserved worktrees |
| [0038](0038-bounded-conversation-history-pagination.md) | Accepted | Read finite message pages through an in-memory canonical JSONL offset index |
| [0039](0039-recoverable-message-submission.md) | Accepted | Confirm saved sends by stable request identity and reconcile only unstarted agent work |
| [0040](0040-workspace-resume-revalidation.md) | Accepted | Revalidate the selected workspace on return without losing drafts or history position |
| [0041](0041-browser-local-conversation-read-state.md) | Accepted | Track unread conversations through browser-local counts and visible latest-page acknowledgement |
| [0042](0042-unread-conversation-navigation.md) | Amended by 0044 | Filter and cycle through unread conversations while preserving current context and selected files |
| [0043](0043-responsive-conversation-containment.md) | Accepted | Reflow conversation controls and provide keyboard scrolling for rich content |
| [0044](0044-first-unread-message-navigation.md) | Accepted | Resolve the first unread ordinal to a stable message link and explicitly acknowledge the current conversation |
| [0045](0045-workspace-run-history.md) | Accepted | Browse paged workspace run history with filters and stable links to triggering messages |
| [0046](0046-portable-workspace-export.md) | Accepted | Export bounded workspace archives with credential exclusions and delivered-byte hashes |
| [0047](0047-local-workspace-archive-inspection.md) | Accepted | Inspect stored workspace ZIP integrity locally in a cancellable browser Worker |
| [0048](0048-deferred-workspace-archive-dialogs.md) | Accepted | Load archive dialogs on demand with bounded retry, focus restoration and navigation guards |
| [0049](0049-run-duration-metrics.md) | Accepted | Expose terminal run elapsed time in run history for performance and cost review |
| [0050](0050-provider-usage-telemetry.md) | Accepted | Retain optional provider-reported token usage for local run cost comparisons |
| [0051](0051-message-knowledge-capture.md) | Accepted | Capture canonical messages as Knowledge documents with source provenance |
| [0052](0052-run-history-agent-comparison.md) | Accepted | Break run-history telemetry down by agent for harness comparison |
| [0053](0053-agent-pricing-profiles.md) | Accepted | Calculate local estimated run cost from user-supplied agent rates |
| [0054](0054-message-quality-feedback.md) | Accepted | Persist explicit helpful or needs-work ratings for agent messages |
| [0055](0055-run-quality-attribution.md) | Accepted | Attribute message ratings to exact producing runs for retry-safe comparison |
| [0056](0056-reviewed-message-knowledge-capture.md) | Accepted | Review and name a message before promoting it to Knowledge |
| [0057](0057-retry-runs-from-history.md) | Accepted | Retry failed and interrupted runs from the monitoring surface |
| [0058](0058-feedback-notes.md) | Accepted | Collect bounded context when marking an agent response needs work |
| [0059](0059-safe-run-failure-kinds.md) | Accepted | Classify run failures without exposing raw error payloads in history |
| [0060](0060-needs-work-review-queue.md) | Accepted | Provide a bounded workspace review queue for needs-work replies |
| [0061](0061-explicit-review-resolution.md) | Accepted | Resolve and reopen needs-work reviews without changing source content |
| [0062](0062-declarative-custom-surfaces.md) | Accepted | Configure safe domain-specific surfaces from bounded card definitions |
| [0063](0063-review-queue-total.md) | Accepted | Return filter-scoped review totals alongside paged needs-work results |
| [0064](0064-review-queue-knowledge-capture.md) | Accepted | Capture reviewed responses directly from the needs-work queue |
| [0065](0065-workspace-whiteboard.md) | Accepted | Keep a bounded redacted Markdown whiteboard per workspace |
| [0066](0066-whiteboard-workspace-export.md) | Accepted | Include saved whiteboard notes in workspace ZIP exports |
| [0068](0068-review-case-export.md) | Accepted | Export a bounded packet of loaded, redacted review cases |
| [0069](0069-run-history-telemetry-export.md) | Accepted | Export bounded loaded run-history telemetry with filters and summary |
| [0070](0070-review-queue-agent-thread-filters.md) | Accepted | Filter needs-work reviews by workspace agent and thread |
| [0071](0071-anthropic-messages-provider.md) | Accepted | Support Anthropic Messages as a custom Master provider |
| [0072](0072-stop-normal-agent-runs.md) | Accepted | Stop normal agent runs from the conversation |
| [0073](0073-per-run-cost-visibility.md) | Accepted | Show derived estimated cost on each run-history row |
| [0074](0074-run-history-cost-summary.md) | Accepted | Summarize filter-scoped estimated run cost with coverage |
| [0075](0075-task-result-knowledge-capture.md) | Accepted | Capture completed Worker results from Taskboard through canonical message provenance |
| [0076](0076-run-history-task-context.md) | Accepted | Show delegated Taskboard titles in run-history rows |
| [0077](0077-quality-adjusted-run-cost.md) | Accepted | Show complete-coverage estimated cost per helpful reply |
| [0078](0078-opt-in-run-history-refresh.md) | Accepted | Add user-controlled refresh for the newest run-history page |
| [0079](0079-batch-run-retry.md) | Accepted | Retry selected failed or interrupted runs sequentially from history |
