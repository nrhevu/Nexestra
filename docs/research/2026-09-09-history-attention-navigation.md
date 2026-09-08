# Research: history-aware attention navigation

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Problem

The Needs attention surface currently opens a pending approval or input by navigating to its
thread (`openThread`). With conversation-history pagination the thread view shows the latest
page (planned default 50 messages); an approval or input whose user or agent trigger is older
than that window would be hidden after the navigation, so the user cannot act on the item from
the attention list.

## Sources and observations

- Notion's document-history help demonstrates version inspection plus restore while preserving
  history; Nexestra's conversation-history work applies the same idea to threads by keeping the
  canonical JSONL transcript and projecting pageable derived state.
- The existing workspace attention projection already carries `runId` on `AttentionItem`
  alongside `threadId` and `taskId`. The planner/planner-delegated runs are current state in
  `dispatcher.activeRuns`, so the parent has enough information to open the exact trigger
  message for a run.
- Linear's Inbox opens the related issue/direct route from a notification; the equivalent here
  is a direct route into the exact message that prompted the pending tool or question rather
  than a bare thread landing page.

## Selected behavior

`AttentionView` gains an optional `onRun?: (threadId: string, runId: string) => void` prop.

- When `onRun` is provided and an item has both `threadId` and `runId` and no `taskId`,
  the row renders **Open run** and calls `onRun(threadId, runId)`.
- Task rows keep **Inspect task** precedence even when they also carry `runId`.
- When `onRun` is absent (stale page, legacy caller, or future surface that only opens bare
  threads), the previous **Open thread** fallback remains, so the component is backward
  compatible.

The parent (root UI agent) wires `onRun` using `data.activeRuns` to resolve
`runId -> triggerMessageId` and calls the existing `openMessage(threadId, messageId)`;
if the run is stale and no trigger message exists, it falls back to `openThread`.

No App/shared/backend edits are part of this slice. The component contract is the only change:
a run-aware navigation hook that preserves task precedence and legacy fallback.

## Acceptance and limits

Focused tests cover exact run identity, two pending runs of the same thread being independently
addressable, legacy fallback when `onRun` is absent, task precedence over run buttons, and the
original thread/task flows. The repository handoff gate is `pnpm check`.

Limits: this slice does not paginate history or resolve `runId` to a trigger message; root is
integrating that resolution in App. If the run disappears between attention refresh and click,
the parent decides the stale fallback; the component does not do its own activity lookup.
