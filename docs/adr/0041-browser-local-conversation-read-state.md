# ADR 0041 - Browser-local conversation read state

## Status

Accepted.

## Context

Workspace resume refreshes metadata and bounded history, but a finished agent reply is not an
attention item. Thread rows show total messages and active work, without distinguishing messages
that arrived after the user last read a conversation. Reviewing old history or a linked message
must not silently acknowledge newer messages outside the visible page.

## Decision

- Keep a browser-local read-through message count for each workspace and conversation. This is UI
  state, separate from the canonical transcript, task status and Needs attention projection.
- On the first workspace observation without a valid saved marker, baseline existing conversations
  at their current counts. A restored workspace, including a saved empty workspace, keeps its
  markers and starts newly discovered conversations at zero. A new installation avoids marking
  the entire retained history unread while still detecting later conversations created elsewhere.
- Derive an unread count from current metadata minus the read-through count. After initialization,
  automatically advance the marker only through an actually loaded latest Messages page when its
  bottom is visible in a focused, visible document, with no covering modal. Old pages, message links, Files & links and background
  tabs retain unread state. A newer metadata count must not acknowledge unloaded messages.
- Show per-conversation unread badges and an aggregate on Threads, including archived conversations.
  Provide an explicit **Mark all conversations read** action and command, using the currently known
  counts without navigation. Initialization and explicit mark-all are the two metadata-based
  exceptions to the automatic acknowledgement rule.
- Persist only versioned workspace/thread identities and counts in browser storage. Merge
  same-origin storage events monotonically, preserve concurrent thread keys, reject malformed or
  oversized data, and continue in memory when browser storage is unavailable.
- Read-state changes must not add API requests, idle polling, provider calls, transcript events,
  or changes to drafts and pending send identities. Retire old viewport callbacks on navigation.

## Verification

Acceptance covers first-use baselines, newly discovered threads, unread growth after background
replies and resume, latest-bottom acknowledgement, old and linked page retention, hidden/unfocused
and modal-covered conversations, newer unloaded metadata, explicit mark-all, persistence and
cross-tab updates, storage failures, and workspace/observer cleanup. Native browser checks must
verify scroll geometry and real storage events rather than infer visibility from a test fixture.

The combined gate passes 574 tests in 43 files, lint, typecheck and the production build. Native
Chromium checks cover older/linked history, scrolling, modal close, Files & links, archived-only
unread, keyboard mark-all at 680px, persisted two-tab storage events and an unfocused fake agent
reply. See the [research and verification record](../research/2026-09-09-conversation-unread-state.md)
for evidence and the focus-emulation limitation.

## Limits

- A read marker records the application's acknowledgement rule, not proof that someone understood
  every message. Reaching the latest bottom acknowledges the loaded conversation through that point.
- State belongs to this browser profile and local origin. It is not a server-side receipt, device
  synchronization, notification history, or cross-workspace activity monitor.
- Counts include all canonical messages, without filtering by author. Cross-tab read/merge/write
  and event repair are best effort; localStorage does not provide an atomic transaction across tabs.
- Each saved workspace payload is limited to 5,000 thread markers and 256 KiB. Excess state remains
  usable in memory but cannot persist until it fits those limits.
- The baseline policy does not reconstruct which retained messages were read before this feature.
  Browser storage may be cleared or denied. Append-only message counts remain the server contract;
  replacing an existing data directory with older history is outside monotonic read-state recovery.
