# Workspace run history — 2026-09-09

## Research and selected idea

[GitHub's workflow run history guide](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history)
connects a list of recent runs with a view of an individual run. The
[GitHub CLI run list reference](https://cli.github.com/manual/gh_run_list) also exposes status and
workflow filters, a result limit, attempts and timestamps. These primary sources support a focused
Nexestra improvement: make earlier agent runs discoverable across conversations, then open their
existing canonical context. Nexestra's agent/conversation filters, seven statuses and page size are
local design choices, not an attempt to reproduce GitHub's workflow model.

Both official pages were fetched directly during this research. The web search tool returned
HTTP 404, so this is a focused primary-source comparison rather than a broad product survey. The
pages disagree about the CLI's default result limit; this change does not depend on either default.

## Implementation and review

Two subagents implemented independent server and UI changes in dedicated worktrees. Root owns
shared contracts, app routing, command entry points, workspace refresh, integration acceptance and
documentation. A third subagent reviews ownership and navigation races without editing the work.

Run history reads a latest-status summary per run from the existing canonical transcript index,
with workspace, agent, conversation and status filters. Keyset pagination returns at most one
50-row UI page. Open run uses the trigger message's stable link and retains drafts and files.
See [ADR 0045](../adr/0045-workspace-run-history.md) for persistence, coverage and cursor decisions.

Review identified two material implementation risks: resolving labels through global metadata could
leak another workspace's identity from a corrupt transcript, and accumulating pages in the UI would
retain an unbounded set of run objects. The chosen design excludes inconsistent conversations and
keeps only the current page plus previous cursors. Newer refetches current data. A separate parent
guard unmounts the previous workspace's list as soon as a switch starts.

Integration review also exposed an unrecoverable failed workspace switch and a clipped long list.
A current failed switch now restores the last loaded workspace, with its error still visible, so
Refresh and switching again work. The run list owns a bounded vertical scroll region. Run history
also omits the context-specific Create button, which previously fell through to creating Knowledge.

## Verification

The first combined `pnpm check` passed 659 tests, TypeScript, lint and production build. Native
Chromium then exposed two gaps that the initial tests did not cover: React StrictMode replay aborted
the first request while the deduplication guard prevented its replacement, and startup metadata
repair reset a missing conversation's known message count, making coverage appear complete. The
follow-up acceptance exercises StrictMode and actual transcript removal/reopen rather than only
ordinary component mounts or private index flags. Both regressions are corrected. A later combined
run passed 660 tests and exposed one timing-dependent older workspace-supervision test; its clock
assumption was replaced with explicit waits for the supervision interval and its asynchronous
bootstrap request before switching workspaces. The stale-response assertions remain unchanged.

The final `pnpm check` passes lint, TypeScript, **661 tests in 48 files**, and production build,
without credentials or live providers. Vitest completed in 26.93 seconds and Vite built in 178ms.
The complete log is `/tmp/nexestra-run-history-check-final.log`. The three delayed-response cases
also passed independently after their synchronization change.

Native QA used a fresh, isolated FileStore with 117 runs in the first workspace, one run in another
workspace, 120 main conversation messages, 90 archived messages and one deliberately removed
nonempty transcript. The fake local runner records invocations and never calls a provider.

| Native check | Observed result |
| --- | --- |
| Initial mount | Run history loaded under the app's real StrictMode entry point. A missing transcript produced an explicit one-conversation coverage warning. |
| Finite pagination | Pages held 50, 50 and 17 rows, with 117 unique run IDs. Older replaced the rows; Newer issued another GET and returned the preceding 50 rows. The last Older control was disabled. |
| Filters | Failed showed 18 matching runs. Reviewer + archived conversation narrowed to two rows and correctly removed the unrelated coverage warning. The unavailable-conversation filter showed an honest partial empty state. |
| Refresh and retry | Global Refresh preserved all three filters and returned page 1. An injected 503 produced a visible Retry action; retry restored the two filtered results. |
| Open run | Keyboard activation opened archived message 8, outside its newest page, at the canonical stable URL. The response contained messages 1–50 of 90, the target received focus, and the archived conversation had no composer. Reload retained the same target. |
| Back and composer | Back returned to Run history. A draft and 66-byte selected file survived another Open run/Back cycle and a workspace switch. Reload retained draft text and required reselecting the file, as documented. Both slash-command spellings opened the surface. |
| Narrow layout | At 320×480, body width was 320px with no run-content overflow; the list had a 386px scrolling viewport. Filters were 242×30px and Older remained reachable. At 390×844, the isolated second workspace showed one run with all filters reset. |
| Integrity | All three canonical transcript SHA-256 hashes matched their baselines, all 35 logged application requests were GET, and the runner recorded zero invocations. Browser warning/error logs were empty. |

Evidence includes 18 browser states, 19 run-history requests and eight conversation-history
requests. The three non-success responses were two expected startup 404s for the previous fixture's
saved workspace (the existing replacement-data fallback recovered) and the deliberate run-list 503.
Fixture seeding and failure controls are separate from the application request log. All 18 integrity
assertions passed. Browser viewport overrides were reset, the QA tab closed, and both local servers
stopped after verification.

Evidence directory:
`/var/folders/cf/kmgsw3k96vd73ryp8r6s9_9r0000gp/T/nexestra-run-history-3supZi`.
`browser-proof.json`, `server-proof.json` and `integrity-proof.json` contain the observations and
assertions. These temporary files are not shipped product data. Main transcript SHA-256:
`f3185a9247484a23247fe871c2aa450c40442e5ba16460c8c21ab5b8312df9f1`.

## Boundaries and follow-up candidates

- Run history discovers ordinary failed chat runs; Needs attention retains its existing current
  decision/task semantics. Opening a historical item does not automatically retry it.
- Refresh and workspace resume update the list and return to page 1, retaining filters. It has no
  background poll or notification.
- Canonical startup scans and O(runs) summary memory remain; listing sorts matching cached runs.
  Out-of-process transcript changes require a restart. Coverage reports the cached index's health.
- Pagination is a live view. Status changes can alter filtered pages, and returning from a message
  or reloading the surface resets filters and page position.
- Error/output text is absent from the list. Existing conversation controls provide details.
  Full-text run search, durations and batch actions would need their own acceptance criteria.
- Native checks cover Chromium desktop and narrow CSS viewports, not physical mobile keyboards,
  other browser engines or assistive-technology output.
