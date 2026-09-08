# Research: resume workspace synchronization

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Problem and primary sources

The app opens thread SSE only for already-known active work and polls background activity only
when its bootstrap knows about background runs. An idle client can miss changes made from another
window or the API. At `ee021c2`, the browser had no return-event revalidation handlers.

[MDN's Page Visibility API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
distinguishes window focus from document visibility and describes background timer throttling.
These are separate resume signals. The implementation coalesces them and checks document
visibility before automatic reads instead of introducing an idle interval.

[MDN's online-event documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/online_event)
explains that the event does not prove a particular server is reachable.
[MDN's onLine documentation](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)
also advises against disabling functionality based on that status. This matters for a loopback
application that may remain usable without Internet access. Online is a retry hint; an actual
successful response establishes that the local view was refreshed.

[MDN's SSE documentation](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
describes reconnection and explicitly closing an EventSource. In Nexestra's current code, an idle
thread has no EventSource, so reconnection cannot supply the missing initial discovery. This is an
inference from the code and the documented lifecycle, not a claim that SSE requires polling.

The official MDN pages were fetched directly over HTTPS and read locally. The web-search tool
returned HTTP 404. No third-party service or new frontend library is needed for the selected design.

## Baseline evidence

Two regression tests on `ee021c2` first persist a send while losing its response, then dispatch a
focus event. Both fail at the awaited bootstrap-read count: focus performs no revalidation.
Their preconditions already establish the pending request identity, draft and selected file.

A preliminary browser fixture had 70 messages, an old 1–20 page and a retained draft. API calls
renamed the conversation, appended message 71 and started an approval-waiting fake worker. Its
unchanged UI and GET count were initially interpreted as a return result. Final QA established
that the browser tool keeps both tabs visible and focus-emulated: `Page.bringToFront` did not
change the selected app tab or window focus. That initial observation only establishes staleness;
it is not evidence of a physical tab return. The final checks below use an explicit Chromium focus
transition and do not claim OS sleep/wake coverage.

## Selected implementation

Revalidate the selected workspace on return, visible online events and an explicit **Refresh
workspace** action. Keep the current draft, selected message and history intent while applying
current metadata and bounded history. Coalesce lifecycle bursts, reject stale responses after
navigation, and make failures retryable without replacing the visible data. See
[ADR 0040](../adr/0040-workspace-resume-revalidation.md).

## Implemented and verified

The coordinator coalesces lifecycle events over 400 ms, runs one cycle at a time with at most one
queued follow-up, drops queued automatic work when hidden, and aborts and retires reads at a 30-second
deadline. A workspace switch or newer history request supersedes old work. Refresh adds no new
server endpoint, write path, provider call or periodic idle timer.

The final `pnpm check` passes **545 tests in 41 files**, lint, typecheck and production build.
Unit/integration coverage includes hidden/visible/online bursts, manual queueing, failure and
retry, a noncooperative timed-out promise and its late completion, old pages, navigation races,
metadata-only surfaces, file inventory and pending submissions. The independent regression suite
waits for actual bootstrap/history reads and the saved message article before retrying a send;
it checks the original request identity and attachment bytes, type and size.

Browser QA uses an isolated server with real storage and a fake worker. Chromium focus emulation
is toggled off/on to generate the browser focus event without reloading; this is distinct from
physically switching tabs. Ordinary buttons and the native file chooser perform other UI actions.

| Check | Observed result |
| --- | --- |
| External rename and message | One focus cycle performs one bootstrap and one bounded history GET; the title updates and Messages 1–20 of 70 becomes 1–20 of 71, retaining the draft, page anchor and composer focus |
| Metadata/history failure | Separate HTTP 503 failures show Retry, retain usable history and draft, and recover on the next explicit refresh |
| Lost send response with a file | The real server saves the message and file but the fixture returns 503; resume performs two GETs and zero POSTs, shows one saved message, and retains the draft/file |
| Explicit confirmation | The second POST returns 200 with `replayed: true` and the original request/message IDs; canonical JSONL contains one message and one artifact for the send, and all 42 attachment bytes match |
| Files & links | Messages performs no full-thread read; opening the inventory loads it, and a later external upload becomes visible after resume |
| Needs attention | A fake approval-waiting run appears after resume; opening it selects its trigger message, manual refresh preserves the linked route, and explicit Deny finishes the fixture and clears attention |
| Idle behavior | GET count remains unchanged for 24.99 seconds after work settles; the original 70-message transcript prefix remains byte-identical |

The narrow browser pane also exposed hidden failure feedback at 567 px: both error text and Retry
had been suppressed by the compact CSS. Feedback now wraps within the top bar, Retry stays visible,
and `aria-describedby` connects the control to the failure status. Native geometry confirms the
message fits inside the 44 px header without covering navigation. The focused accessibility test
checks that the description is removed after recovery.

Fixture request logs, browser observations and canonical/file checks were retained under the local
temporary directory `nexestra-resume-sync-S9NeCD`; no production data or live provider was used.
The tools did not reproduce physical tab visibility changes or OS sleep/wake. Those remain manual
platform checks; lifecycle scheduling and hidden-state behavior are covered deterministically.

## Archived notice readability

The same native fixture confirmed that the archived-thread notice used a fixed pale text color
in the light theme. Its computed foreground and composited background had a contrast ratio of
approximately 1.14:1. Using the existing panel and muted-text theme tokens raises that notice to
5.07:1 in light mode and 6.72:1 in dark mode. These figures were calculated from browser-rendered
RGB colors, including the original alpha-composited background.

[MDN's color-contrast guide](https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Perceivable/Color_contrast)
lists 4.5:1 for normal body text at the AA level. This check concerns the archived notice itself.
The MDN page was fetched and read; the direct W3C Understanding-page request returned HTTP 403.
