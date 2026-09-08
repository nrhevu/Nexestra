# Research: history-aware attention navigation

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Problem

The Needs attention surface opens a pending approval or input by navigating to its thread. With
conversation-history pagination the thread view shows a bounded latest page (planned 50 messages);
an approval or input whose trigger message is older than that window would be hidden after the
navigation, so the user cannot act on the item from the attention list.

## Source observations

- `AttentionItem` in `src/shared/contracts.ts` carries `threadId`, `runId`, and `taskId`;
  `runAttentionItem` builds the pending items from the workspace activity projection.
- `dispatcher.activeRuns` supplies the current runs used to build that projection, and each run
  records `triggerMessageId` on `RunSchema`. Resolving `runId -> triggerMessageId` therefore
  lets the parent open the exact message that prompted the pending tool or question.
- `src/web/App.tsx` already has `openThread(threadId)` and `openMessage(threadId, messageId)`
  navigation routes, including a message-target route, so a run-aware hook does not need new
  routing machinery.

These are local code observations, not external product research.

## Selected behavior

`AttentionView` gains an optional `onRun?: (threadId: string, runId: string) => void` prop.

- When `onRun` is provided and an item has both `threadId` and `runId` and no `taskId`,
  the row renders **Open run** and calls `onRun(threadId, runId)`.
- Task rows keep **Inspect task** precedence even when they also carry `runId`.
- When `onRun` is absent, the previous **Open thread** fallback remains so callers that only
  open bare threads keep working.

The accessible button name is `Open run: <title>`; run identifiers stay out of the product text
and are passed only through the callback. The parent resolves the run to its trigger message and
navigates with `openMessage`, falling back to `openThread` when the run is stale and no trigger
message exists.

## Acceptance and limits

Focused tests cover empty state, original thread/task flows, two pending runs with the same
visible title being independently addressable to their exact run ids, legacy fallback when
`onRun` is absent, and task precedence over run buttons.

Limits: this change does not paginate history or resolve `runId` to a trigger message; the
parent performs that resolution. If the run disappears between attention refresh and click, the
parent decides the stale fallback; the component does not perform its own activity lookup.
