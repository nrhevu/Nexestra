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
