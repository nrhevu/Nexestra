# ADR 0044 - First unread message navigation

## Status

Accepted. Amends ADR 0042's latest-page destination for Next unread.

## Context

Unread filtering identifies conversations, but opening the latest 50 messages can skip the start
of a longer unread backlog. ReadState deliberately stores counts rather than transcript content or
message IDs. The server already has an ordered canonical message offset index, so it can validate
an ordinal and return the real ID in a bounded response.

## Decision

- Extend the workspace-scoped history request with `at`, a positive safe integer representing a
  1-based message ordinal. It is mutually exclusive with `before`, `after` and `around`. Existing
  limits remain: 50 messages by default, at most 100, and the existing byte/identity guards.
- Resolve the ordinal directly from the index, then use the existing centered-page planner. Do
  not resolve to an ID and rescan the whole message index. A successful response includes
  `targetMessageIndex`, `targetMessageId` and `targetFound: true`. A missing ordinal, including in
  an empty thread, returns the bounded recent fallback with `targetFound: false` and no target ID.
- Add First unread and Mark read controls in both Messages and Files, with matching slash commands.
  First unread and Next unread derive the current ordinal from current workspace metadata and
  read markers at activation. Next retains the active-then-archived sidebar order and wraparound.
- Resolve `at` once, validate that the returned target occupies the requested ordinal in the
  loaded page, and navigate to the stable `?message=` URL with an `around` intent. Reuse existing
  target focus, highlighting and scroll behavior. Refresh/reload subsequently use the message ID.
  Resolving a newly opened conversation replaces its transient bare URL; reopening the same target
  avoids another history entry. The explanatory first-unread notice is transient UI context.
- Opening first unread switches Files to Messages and preserves drafts and selected files. It
  does not advance a read marker. Keep missing-ordinal fallback in an anchored intent so viewing
  its recent page cannot silently mark the backlog read; Show latest is an explicit exit.
- Coalesce matching pending ordinal requests. Show latest follows the requested history intent,
  so it can supersede a pending or failed lookup even when the previous loaded page was latest.
  Browser Back invalidates an incompatible pending intent even if its destination URL is identical;
  a latest request already matching that URL is retained. Workspace and request guards discard
  stale responses before they can navigate, change a marker, or replace another conversation.
- Mark read acknowledges only the current conversation's highest known metadata/current-page
  total. It retains the selected tab, anchor and transcript position. The same behavior works for
  archived conversations and uses existing bounded, monotone browser-local storage. No read action
  calls an agent, mutates server metadata, or writes the canonical transcript.

## Verification

Server acceptance covers first/middle/last ordinals, missing/empty fallback, invalid and mixed
anchors, bounded file access, append/reopen stability, and HTTP results. UI acceptance covers
backlogs longer than a page, stable refresh, explicit local acknowledgement, lagging metadata,
archived Files, empty surface commands, fresh cross-tab markers, retry, coalescing, unavailable
targets, delayed responses after Show latest/workspace switches, and Back to an identical URL.

Native Chromium and the final combined gate are recorded in the
[research and QA record](../research/2026-09-09-first-unread-navigation.md).

## Limits

Read markers remain browser-local read-through counts, with the limits in ADR 0041. They do not
track partial reading progress within anchored history or reconstruct reading after replacing a
data directory. All canonical messages contribute to the count. First unread uses known metadata,
so idle external work may need Refresh before it appears. The canonical index still requires its
existing startup/prime scan; per-request bounded reads do not remove that cost. Files retains its
existing full inventory route. Physical mobile devices, software keyboards, other browser engines
and assistive-technology output are not covered by this native Chromium run.
