# Research: conversation unread state

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Observed gap

At `90b82ed`, conversation rows expose total message counts, drafts and active-run badges. Needs
attention reflects pending decisions and task failures, so a completed reply can disappear from
active work without leaving a signal that its conversation has new messages. Resume revalidation
now discovers those changes, but the browser has no record of the last conversation state read.

An isolated browser fixture on that commit confirms the distinction: a public API call saves a
message in another conversation, then Refresh updates its sidebar row to `# External work 1`.
Needs attention remains zero and Threads has no unread summary. This is a deliberate fixture,
not a measurement of how often users miss replies.

## Primary sources and design

[MDN's storage-event documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event)
states that localStorage changes notify other browsing contexts of the same origin, while the
initiating document does not receive that event. A browser-local read marker can therefore update
its own App state immediately and merge events from other tabs. Events are not a transaction or
conflict-resolution protocol; monotonic count merging is a Nexestra design decision.

[MDN's Web Storage overview](https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API)
describes its synchronous operations and their potential to block JavaScript. Mark-all should
persist one merged workspace update, rather than rewrite it once for every conversation. Marker
payloads need explicit limits, and storage failures must leave in-memory reading state usable.

[MDN's Intersection Observer documentation](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API)
describes asynchronous intersection observations against a scroll container or viewport. It can
establish whether the conversation bottom is in view. Intersection alone does not establish that
the browser is focused or that a modal is not covering the conversation; those are separate gates.

[MDN's Page Visibility documentation](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
distinguishes document visibility from focus. Both matter when deciding whether a background reply
should retain an unread badge. Focus and visibility events should re-evaluate local read state
without fetching another transcript or changing the existing resume request coordinator.

The MDN pages were fetched directly over HTTPS and read locally. The web-search tool returned
HTTP 404. The selected behavior follows the local code and these browser APIs; no new library,
server receipt or notification service is needed.

## Selected implementation

Keep browser-persisted read-through counts per workspace/conversation, derive unread badges from
fresh metadata, and acknowledge only a loaded latest page whose bottom is visible to the user.
First-use baselines avoid a backlog of unread flags on existing data. Explicit mark-all acknowledges
the current known counts. Old history, linked messages, inactive tabs and covering modals keep their
unread state. See [ADR 0041](../adr/0041-browser-local-conversation-read-state.md).

Two implementation subagents split the state helper and UI; a third reviewed acknowledgement
guards independently. Integration review corrected a stale storage-event path that changed the
in-memory counts without telling React to render, and avoided redundant writes when the current
storage snapshot already contains the merged result. The UI uses an absolute `lastMessageIndex`
from the loaded page: a 50-message page ending at message 70 acknowledges through 70. A pending
history request invalidates acknowledgement of its predecessor. Queued intersection callbacks
recheck current geometry, and unmount cancels the observer and pending animation frame.

The UI exposes the full `/mark all read` command as well as its displayed label. Native testing
caught the original label-only matcher accepting `/mark all` but rejecting the documented full
command; the regression now types the complete command. Archived unread rows retain full opacity:
their initial light-theme badge contrast was approximately 3.58–3.60:1 after compositing the row's
0.78 opacity against the sidebar gradient. The final text/background pair is 5.36:1. Mark-all and
create-thread actions measure 24×24 CSS pixels. Row unread calculations use the row's existing
metadata instead of repeatedly searching the complete thread list.

## Verification

Final `pnpm check` passes **574 tests in 43 files**, lint, typecheck and the production build. This
includes 14 read-state tests, viewport-gate and observer tests, App integration cases and the command
test. Coverage includes fresh/restored/empty baselines, newly discovered threads, malformed and
oversized storage, denied writes, monotonic merging, delayed Show latest, absolute indexes over 50,
visible geometry while hidden/unfocused/modal-covered, Files & links receiving a newer message,
retired observers, archived totals and recovery of the storage-unavailable notice. Existing
recoverable-submission and resume tests also pass with fake transports.

The native fixture uses the real loopback API and FileStore, 70 initial messages, another active
conversation, an archived conversation and a second workspace. Its fake runner waits for an
explicit local tool decision and executes no provider, command or file read. Chromium checks gave
these results:

| Case | Observed result |
| --- | --- |
| First use | Existing counts 70, 1 and 1 start read; no historical unread flood. |
| Old page | Page 1–20 of 71 retains its unread message even with the bottom sentinel visible. Other and archived conversations each add one to the total. |
| Explicit mark-all | Clears all three badges, keeps the exact old page, draft and selected 84-byte file. Request counts remain 19 before and after the action. |
| Latest page and scrolling | Show latest reads through index 72 using a 50-message page. A later message remains unread while scrolled up; scrolling to the bottom advances 73 to 74. |
| Covering dialog | A new message reaches the loaded latest page while Rename is open, but the marker stays 74. Closing the dialog remeasures the visible bottom and advances to 75. |
| Files & links | A new message loads while Files & links is selected; its marker stays 75. Returning to Messages at the latest bottom advances to 76. |
| Two tabs | Reading the other conversation in tab B updates tab A through a real storage event. Reading in A updates B in return; both markers survive B's reload. The return-to-Messages/storage-update step leaves request counts unchanged at 49. |
| Unfocused reply | The fake agent's completed reply reaches latest page 29–78 while `document.hasFocus()` is false. Its marker stays 77, then advances to 78 after focus returns with the bottom visible. |
| Linked history | A link to message 5 stays on page 1–50 of 79 and retains the new unread message. Show latest acknowledges it, leaving only the archived badge. |
| Compact command | With only an archived unread message and a 680×800 viewport, `/mark all read` is selectable by keyboard. It clears the badge, retains draft/file and leaves request counts unchanged at 74. |
| Archived reading | Opening the archived latest page acknowledges through message 4. Restore remains available and the message composer remains absent. |
| Idle workspace | Over 144 seconds after activity finished, API request counts remain at 80: no GETs or mutations are added. |

The original 70 canonical JSONL records remain byte-identical (SHA-256
`4f7b40a1dd470a547b5f927d453784ba7197250255c15206550a0316948e3e5f`). The selected transcript ends
with 79 messages: 78 user notes and one response from the sole explicit fake invocation. The only
record types are the existing message, run and tool events; server state has no read-state field.
The finished fake run leaves no active work or attention item.
The final browser error/warning log is empty. Both test tabs and the isolated servers were closed
after verification; the fixture files remain available for inspection.

Local evidence is retained under
`/var/folders/cf/kmgsw3k96vd73ryp8r6s9_9r0000gp/T/nexestra-unread-j9my8H/`: `browser-proof.json`
contains 29 captured states and five style checks; `durability-proof.json`, `requests.jsonl` and
the before/after snapshots record persistence and request counts. Preliminary snapshots taken
while implementation edits triggered Vite refresh are distinguished from the final scroll cases.

## Limits and next candidates

The browser tooling emulates window focus and reports its tool-created tabs as visible. Native
focus checks use Chromium's focus-emulation control; physical OS/tab switching and hidden-document
behavior were not independently exercised. Hidden state is covered by deterministic tests.
This is the same limitation documented in the [resume report](2026-09-09-workspace-resume-revalidation.md).

Markers belong to a browser profile/origin, count all canonical message authors and do not prove
that every message was understood. Initialization and explicit mark-all intentionally use metadata.
Storage loss, denial and bounded payloads can limit persistence; same-origin merging is best effort
because read/write is not an atomic transaction across tabs. This feature adds no idle polling,
server receipt or cross-device synchronization. It does not change pending sends or agent dispatch.

Possible next work is an unread-only conversation filter or a keyboard action for the next unread
conversation. Desktop notifications would need a separate opt-in design; they are not part of this
change.
