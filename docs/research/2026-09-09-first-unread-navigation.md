# First unread message navigation — 2026-09-09

## Research and selected idea

[Zulip's reading strategies](https://zulip.com/help/reading-strategies) describe reading by
conversation, visiting unread conversations in sidebar order, and starting channel/direct-message
feeds at the first unread message. That supports a concrete improvement to Nexestra: retain the
existing unread list, but open the start of the unread backlog instead of skipping to its last page.
This is an adaptation to Nexestra's browser-local count model, not a claim that its receipts or
keyboard navigation match Zulip's implementation.

[MDN's scrollIntoView reference](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoView)
documents alignment and ancestor scrolling. The implementation reuses Nexestra's tested target
focus/centering behavior and avoids introducing another scroll container or new browser-dependent
scroll option.

Both primary pages were fetched directly during this research. The web search tool was unavailable
(HTTP 404), so this is a focused primary-source comparison rather than a broad product survey.

## Implementation and review

Two subagents implemented independent parts in dedicated worktrees: the server ordinal anchor and
the conversation controls/command palette. Root integrated routing, read-state actions and acceptance
tests; a third subagent reviewed races and workspace isolation without editing the integration.

`at=N` resolves an ordinal directly from the canonical offset index, returning one bounded page
and the real message ID. Root validates the position before converting the pending lookup into a
stable message link. First/Next unread preserve the unread count; Mark read explicitly acknowledges
only the current conversation while retaining its view. See
[ADR 0044](../adr/0044-first-unread-message-navigation.md) for the API and state decisions.

Acceptance exposed a disabled Show latest action while an ordinal request was pending from a
latest page. Its availability now follows the requested history intent. Review also identified that
Back to a duplicate bare URL could be overwritten by a late ordinal response. Back now restores the
destination intent, while the earlier acceptance contract still retains an initial latest request
when repeated navigation already matches it. Mark read uses the highest known current-page or
metadata count so lagging metadata does not leave already acknowledged messages behind.

## Verification

The final `pnpm check` passes lint, TypeScript, **624 tests in 46 files**, and the production
build, without live providers or credentials. Tests took 19.42 seconds and Vite built in 215ms.
The complete log is `/tmp/nexestra-first-unread-check-final.log`. The earlier combined run passed
all tests but caught an optional-ref TypeScript error in Show latest availability; the final gate
includes that correction.

Native QA uses an isolated temporary FileStore with 140 selected messages, another active
conversation and an archived conversation. Initial browser markers baseline 20 selected messages;
explicit fixture appends then create 120 unread selected messages and two in each other conversation.
The runner reports a fake local status and records any invocation; it never calls a live provider.

| Native check | Observed result |
| --- | --- |
| First unread from Files | A single `at=21` request returned messages 1–50 of 140 and the canonical ID of message 21. The selected message received focus; 120 messages remained unread. |
| Stable Refresh | Refresh requested `around=<resolved-ID>` and retained message 21, the draft and the 58-byte selected file. |
| Error and retry | Injected history failure retained the existing anchor and draft/file; explicit Try again resolved the same target with 120 unread. |
| Mark current from Files | `/mark read` left Files and the message URL in place. Logged request count stayed 19 before/after; the other active and archived conversations kept two unread each. |
| Return to Messages | The file and draft remained; transcript scrollTop stayed 2355 CSS pixels at 320×480. |
| Next unread | Next opened archived message 2, then active message 4. Both pages still showed two unread, even though their complete short history was loaded. Archived view kept Restore and no composer. |
| Back | Browser Back returned through the archived link to original message 21, preserving the draft and selected file. |
| Reload | Message 21 and its read marker remained, draft text was restored, and selected file bytes were absent as documented. |
| Responsive geometry | Body width matched 320, 390 and 1272px viewports. At 320×480 the transcript retained 120px and the composer ended at y480. At 390×844 both remained inside the viewport. Keyboard actions reached controls in the scrollable header. |
| Integrity | All three canonical transcript hashes were unchanged after navigation; zero runner invocations. Browser warnings/errors were empty. |

The run recorded **26 application requests, all GET**, including two deliberate 503 responses.
Fixture seeding and failure controls are separate from that application request log. The evidence
contains 12 browser states, request details and assertion results in `integrity-proof.json`.
Selected transcript SHA-256:
`99efbd7a47baf11d6e617de41a33e22e87ac9885e87f5ce3ef7f64800037b5fc`.
The native tab and both fixture servers were stopped and the viewport override reset after QA.

Evidence directory:
`/var/folders/cf/kmgsw3k96vd73ryp8r6s9_9r0000gp/T/nexestra-first-unread-V9l8Ul`.
These temporary data files and browser evidence are not shipped product data.

## Boundaries and follow-up candidates

- The marker is a browser-local count of all messages. Anchored browsing does not advance it one
  message at a time; users explicitly Mark read or choose Show latest and reach its bottom.
- Reload keeps draft text, read markers and the message URL; selected File bytes remain session-only.
- Idle metadata freshness remains an explicit Refresh/resume concern. There is no cross-workspace
  unread inbox or background monitoring in this change.
- A future reading-position feature would need a separate decision about partial progress and
  transcript replacement. It should not infer durable progress merely from a target being focused.
- Native geometry covers Chromium desktop and narrow/short viewports; it does not substitute for
  physical phones, touch keyboards, other engines, or screen-reader validation.
