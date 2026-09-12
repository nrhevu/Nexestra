# Documentation index — Milestone M9

1. [README](../README.md): quickstart and product behavior.
2. [Architecture](ARCHITECTURE.md): data flow, persistence, runtime, and known gaps.
3. [ADR index](adr/0000-index.md): architecture decisions for the rebuild.
4. [Contributing](../CONTRIBUTING.md): development loop and change rules.
5. [Attention and navigation research](research/2026-09-08-attention-navigation.md): source-backed
   ideas, selected scope, and follow-up candidates.
6. [Resumable workspace research](research/2026-09-08-resumable-workspaces.md): drafts, profile editing,
   workspace management, and canonical manual delegation.
7. [Repository recovery and review research](research/2026-09-08-repository-recovery-review.md):
   clone recovery, stable assignment comparisons, Git execution boundaries, and next candidates.
8. [Lifecycle, history, and source refresh research](research/2026-09-08-lifecycle-history-source-refresh.md):
   reversible thread archival, immutable document revisions, and refreshed Worker starting commits.
9. [Transcript search research](research/2026-09-09-transcript-search.md): finding remembered messages
   across active and archived conversations, with explicit scan completeness and local data limits.
10. [Next local workflow candidates](research/2026-09-09-next-local-workflows.md): explicit source
    branch choice and the unresolved scope of a portable workspace export.
11. [Knowledge preview research](research/2026-09-09-knowledge-preview.md): current and historical
    plain-text inspection with integrity verification, truncation and download fallback.
12. [Repository branch selection research](research/2026-09-09-repository-branch-selection.md):
    choosing a source branch for future Workers, preserving existing work, and Unicode Git output.
13. [Conversation history research](research/2026-09-09-conversation-history.md): bounded message
    pages, stable linked targets, indexed JSONL reads and active work outside the current page.
14. [Recoverable submission research](research/2026-09-09-recoverable-message-submission.md): stable
    send identities, durable receipt recovery, attachment reuse and partial dispatch verification.
15. [Copy message links research](research/2026-09-09-copy-message-links.md): direct links from saved
    message rows, clipboard confirmation and manual fallback on the existing local route.
16. [Workspace resume research](research/2026-09-09-workspace-resume-revalidation.md): refresh on
    return, bounded read cycles, retained drafts and pending sends, and archived-notice contrast.
17. [Conversation unread research](research/2026-09-09-conversation-unread-state.md): browser-local
    read markers, visible latest-page acknowledgement, archived totals and cross-tab merging.
18. [Unread navigation research](research/2026-09-09-unread-conversation-navigation.md): All/Unread,
    next-unread commands, current-row retention and selected files across workspace navigation.
19. [Conversation reflow research](research/2026-09-09-conversation-reflow.md): narrow and short
    viewports, keyboard scrolling for rich content, and complete long-URL persistence.
20. [First unread research](research/2026-09-09-first-unread-navigation.md): bounded ordinal lookup,
    stable message links, explicit current-conversation acknowledgement and navigation races.
21. [Workspace run history research](research/2026-09-09-workspace-run-history.md): paged run
    discovery, filters, trigger links and explicit incomplete coverage.
22. [Workspace export research](research/2026-09-09-workspace-export.md): portable ZIP contents,
    credential boundaries, source consistency and cancellation.
23. [Local archive inspection research](research/2026-09-09-local-workspace-archive-inspection.md):
    Worker-based CRC/SHA verification, supported ZIP profile and integrity limits.
24. [Deferred archive dialog research](research/2026-09-09-deferred-workspace-archive-dialogs.md):
    measured initial bundle reduction, bounded loading, native failures and focus preservation.
25. [Run quality attribution research](research/2026-09-12-run-quality-attribution.md): exact run
    provenance for retry-safe helpful/needs-work comparisons and a reviewed Knowledge follow-up.
26. [Reviewed Knowledge capture research](research/2026-09-12-reviewed-knowledge-capture.md): an
    explicit source preview and naming step before promoting a message to durable Knowledge.
27. [Run history recovery research](research/2026-09-12-run-history-recovery.md): expose guarded
    retry at the failed or interrupted run where monitoring already happens.
28. [Feedback note research](research/2026-09-12-feedback-notes.md): preserve human context beside
    needs-work ratings without turning them into automatic evaluation scores.
29. [Safe run failure kinds research](research/2026-09-12-safe-run-failure-kinds.md): classify
    monitoring failures without copying raw provider or command errors into the history response.
30. [Needs-work review queue research](research/2026-09-12-needs-work-review-queue.md): revisit
    bounded, redacted negative ratings before deliberate Knowledge capture.
31. [Review resolution research](research/2026-09-12-review-resolution.md): record reversible,
    explicit review completion while preserving ratings and source content.
32. [Declarative custom surfaces research](research/2026-09-12-declarative-custom-surfaces.md):
    adapt workspace navigation through bounded, allowlisted cards instead of executable UI code.
33. [Review queue Knowledge capture research](research/2026-09-12-review-queue-knowledge-capture.md):
    connect needs-work review to explicit, provenance-preserving Knowledge capture.
34. [Workspace whiteboard research](research/2026-09-12-workspace-whiteboard.md): keep a bounded,
    redacted Markdown planning surface per workspace.
35. [Whiteboard export research](research/2026-09-12-whiteboard-workspace-export.md): preserve saved
    planning notes in the existing redacted workspace ZIP workflow.
36. [Review prompt context research](research/2026-09-12-review-prompt-context.md): show the bounded,
    redacted user request beside each needs-work response.
37. [Review case export research](research/2026-09-12-review-case-export.md): carry loaded, redacted
    review rows with prompt and run provenance into offline evaluation tools.
38. [Run-history telemetry export research](research/2026-09-12-run-history-telemetry-export.md):
    carry bounded filtered run rows, cost telemetry, and complete summary into offline analysis.
39. [Review queue agent and thread filters research](research/2026-09-12-review-queue-agent-thread-filters.md):
    narrow needs-work triage by workspace-scoped agent or conversation while preserving cursor safety.
40. [Anthropic Messages provider research](research/2026-09-12-anthropic-messages-provider.md):
    adapt Anthropic's bounded Messages and streaming tool-use protocol into the provider-neutral Master loop.
41. [Stop normal agent runs research](research/2026-09-12-stop-normal-agent-runs.md):
    reuse local abort signals to stop ordinary chat runs while preserving durable retry history.
42. [Per-run cost visibility research](research/2026-09-12-per-run-cost-visibility.md): show derived,
    redacted estimated cost beside each run-history row for task-level harness comparison.
43. [Run-history cost summary research](research/2026-09-12-run-history-cost-summary.md): add a
    filter-scoped estimated total with explicit coverage for harness price comparisons.
44. [Task-result Knowledge capture research](research/2026-09-12-task-result-knowledge-capture.md):
    transfer completed Worker replies from Taskboard through the existing reviewed capture flow.
45. [Run-history task context research](research/2026-09-12-run-history-task-context.md): add
    redacted delegated Taskboard titles to monitoring rows without changing pagination semantics.
46. [Quality-adjusted run cost research](research/2026-09-12-quality-adjusted-run-cost.md): relate
    estimated spend to helpful feedback only when coverage is complete.
47. [Opt-in run-history refresh research](research/2026-09-12-opt-in-run-history-refresh.md): keep
    the newest monitoring page current without disturbing older-page navigation.
48. [Attention snooze and dismissal research](research/2026-09-12-attention-snooze-dismiss.md): defer
    derived workspace attention items with bounded, durable metadata.
49. [Attention snooze durations research](research/2026-09-12-attention-snooze-durations.md): provide
    fixed one-hour, four-hour, and one-day deferral choices.
50. [Attention state workspace export research](research/2026-09-12-attention-state-workspace-export.md):
    preserve selected workspace monitoring triage in portable ZIP state.
51. [Knowledge revision pruning research](research/2026-09-12-knowledge-revision-pruning.md): remove
    explicitly selected old immutable document revisions while retaining recent history.
52. [Review queue bulk resolution research](research/2026-09-12-review-queue-bulk-resolution.md): mark
    selected visible needs-work rows reviewed in order.
53. [Workspace activity summary research](research/2026-09-12-workspace-activity-summary.md): show
    bounded active-run and attention counts across the workspace rail.
54. [Live workspace activity refresh research](research/2026-09-12-live-workspace-activity-refresh.md):
    conditionally poll count-only activity summaries while work is active.
55. [Custom surface run count research](research/2026-09-12-custom-surface-run-count.md): show
    selected-workspace active-run counts on declarative Run history cards.
56. [MCP resource reads research](research/2026-09-12-mcp-resource-read.md): expose bounded,
    catalog-gated resource reads to the harness.
57. [MCP prompt expansion research](research/2026-09-12-mcp-prompt-expansion.md): expose bounded,
    catalog-gated prompt expansion to the harness.
58. [MCP resource templates research](research/2026-09-12-mcp-resource-templates.md): read
    cataloged parameterized MCP resources with bounded URI expansion.
59. [Run cost budget signal research](research/2026-09-12-run-cost-budget-signal.md): flag
    observed run estimates that exceed an agent's optional per-run limit.
60. [Custom surface review count research](research/2026-09-12-custom-surface-review-count.md):
    show selected-workspace open review counts without exposing queue content.
61. [Cross-workspace run telemetry research](research/2026-09-12-cross-workspace-run-telemetry.md):
    compare count-only cost and usage aggregates while preserving workspace isolation.
62. [Over-budget run filter research](research/2026-09-12-over-budget-run-filter.md): focus run
    history on observed estimates above configured per-agent limits.
63. [Agent profile labels research](research/2026-09-12-agent-profile-labels.md): identify
    heterogeneous harness and model labels without exposing provider configuration or secrets.
64. [Attention audit history research](research/2026-09-12-attention-audit-history.md): retain
    bounded workspace-scoped snooze and dismiss actions without alert content.
65. [Opt-in desktop Attention notifications research](research/2026-09-12-opt-in-desktop-attention-notifications.md):
    notify a browser about increased workspace counts only after explicit permission.
66. [Over-budget custom surface card research](research/2026-09-12-over-budget-custom-surface-card.md):
    expose complete-coverage observed budget counts and filtered Run history navigation.
67. [Workspace archive identity check research](research/2026-09-12-workspace-archive-identity-check.md): compare a verified archive's manifest workspace ID with the active workspace before manual review.
68. [Run history CSV export research](research/2026-09-12-run-history-csv-export.md): add a bounded, client-only spreadsheet export for loaded telemetry without transcript or error text.
