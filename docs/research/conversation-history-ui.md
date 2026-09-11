# Conversation history pagination UI

This slice replaces the previous single-page transcript view with a finite, server-paginated window while keeping the rest of the conversation surfaces (attention, drafts, composer, artifacts) working on live updates.

## Contract

- `GET /api/threads/:id/history?workspaceId=...&limit=50&before=<messageId>` (or `after`/`around`) returns a `ThreadHistoryPage`: the finite message window plus whole-thread `activeRuns` and page metadata (`totalMessages`, `totalArtifacts`, `firstMessageIndex`, `lastMessageIndex`, `beforeCursor`, `afterCursor`, optional `targetMessageId`/`targetFound`).
- `GET /api/threads/:id/metadata` returns a `Thread` for bare foreign deep links; it deliberately does not read the JSONL transcript.
- The legacy `GET /api/threads/:id` full transcript remains only for the explicit Files & links tab.

## Behavior

- The transcript renders at most 50 (default limit) messages. Older messages / Newer messages fetch the previous/next window; Show latest resets the URL and loads the newest window even for the same thread. The range line shows `Messages X–Y of Z`; empty threads say `No messages yet`.
- Deep links (`/threads/:id?message=:id`) load an `around` window, focus and highlight the linked message, and keep the URL intact. Older/newer navigation clears the linked-message URL; Show latest does too. A missing target returns the latest window with the notice `The linked message is not available in this thread.`
- A bare foreign `/threads/:id` deep link is resolved once via `GET /api/threads/:id/metadata`, then the app switches to that thread's workspace and loads its history. Route/workspace/generation and request-id guards ensure stale lookup replies, delayed old-workspace history replies, popstate, and background activity refreshes cannot replace the current view.
- History intents are committed at dispatch, so a quiet SSE/poll refresh can never supersede a user's pending Older/Newer request, and Retry reloads the failed intent rather than the previous page. Quiet failures still settle loading so paging stays usable.
- While a thread has active runs, SSE (or 1 s polling fallback) quietly reloads the same window. A latest window auto-follows new messages only when the user is near the bottom; historical pages stay still. When the final active run disappears, a queued quiet refresh completes so the page does not show a stale running state. Runs outside the window remain reachable through page controls and the Needs attention `Open run` action (which issues an `around` load for the run's trigger).
- Message sections are focusable (`tabIndex={-1}`) so explicit page navigation can focus the first/last new message without adding tab-order stops.
- Linked-message centering accounts for lazy markdown: the initial `scrollIntoView` is followed by an rAF-based watcher that re-centers while the target's height changes, stops once the markdown fallback is gone and the layout is stable for two frames, and stops immediately if the user scrolls. It never restarts for a quiet refresh of the same target.
- Files & links is lazy: opening the tab requests the full `GET`, keeps the old author metadata, and refreshes once while active when the page-reported artifact count no longer matches the cached full inventory. Closing the tab never triggers a full GET. The full-transcript cache holds only the most recent thread, avoiding full copies for every visited thread.
- Date dividers label a message's actual local day (`Today`/`Yesterday` or a formatted date) instead of hardcoding every thread as `Today`.

## Tests

`src/web/ConversationHistory.test.tsx` (15 tests) covers the finite window and DOM count across Older/Newer/Show latest, linked targets inside and outside the latest window, missing targets, bare-thread Show latest followed by switching threads, failed-Older retry, quiet refresh sharing/committed intents, quiet-failure loading settlement, explicit-only page focus, delayed old-workspace responses, attention-run navigation to an off-page trigger, lazy Files & links with cached author data, cross-day dividers, send-then-latest clearing the target, and the async markdown centering watcher (initial center, re-center on height change, user-scroll stop, no recenter on later changes/quiet refresh). `MessageNavigation.test.tsx` keeps the exact-message routing/preview suite. `App.test.tsx` exercises the last-thread/foreign-lookup/background-refresh safety on the migrated history endpoints.

## Limits and known gaps

- The 50-message window is the only transcript view; there is no infinite scroll or client-side search. Searching messages remains a separate feature.
- The full Files & links inventory is fetched on demand and cached for one thread; reopening a different thread re-fetches, and a still-open tab updates only when the artifact count changes or the tab is re-opened.
- The centering watcher gives up after 180 frames (about 3 s at 60 Hz) so a pathological layout that keeps growing after that is not chased forever.

