# ADR 0042 - Unread conversation navigation

## Status

Accepted.

## Context

Read markers distinguish new messages, but finding their rows still requires scanning every
conversation. Archived unread messages contribute to the total and need an explicit route into
the reading workflow. Navigation must preserve unsent text and selected files.

## Decision

- Add native All/Unread toggles with stable labels and `aria-pressed`. Their badge counts
  conversations; existing row and Threads badges continue to count messages. Filtering is a local
  projection and does not request history, acknowledge messages, or change the open conversation.
- Include archived conversations and retain the selected row after its unread count reaches zero.
  Explain the retained row when no unread conversations remain. Preserve context and focus instead
  of showing a misleading create-first-thread prompt.
- Keep the filter in App memory per workspace across surfaces and workspace switches. Reload starts
  with All, so a temporary filter cannot conceal conversations next time.
- Add Next unread conversation and `/next unread` through the existing command palette. Resolve
  from current workspace metadata and read markers when invoked. Follow sidebar order: active
  first, then archived, preserving order within each group and wrapping after the current row.
  Deduplicate IDs and exclude foreign workspace entries before deriving the list.
- If only the current conversation is unread, explicitly open latest Messages. Leave linked/older
  history or Files only on that explicit action. Share an already pending latest request and avoid
  another browser history entry for a bare current URL. With none, disable the sidebar action and
  let the command report an empty result locally.
- Own selected File arrays at App scope, keyed by workspace/thread. Keep actual objects through
  route unmounts, clear submitted objects only when their request is still the pending identity,
  and keep bytes out of storage. An older response must retain files reused by a newer send.
  An unchanged failed payload retains its request ID after navigation. In-session edits remain
  new intent; reloaded attachment recovery still requires the original fingerprint.
- Separate explicit opening of Messages from scrolling after a send. Completion of an in-flight
  send must not pull someone out of Files or clear another workspace's draft.

## Verification

Acceptance covers ordering, wraparound, the selected-row exception, duplicate/foreign IDs,
immutability, native toggle semantics, the full slash command, local filtering, archived navigation,
pending latest request coalescing, fresh storage markers at selection, workspace filter/file isolation,
reload semantics and asynchronous send completion. See the
[research record](../research/2026-09-09-unread-conversation-navigation.md) for the final gate and browser evidence.

The combined gate passes 596 tests in 45 files, lint, typecheck and the production build. Native
checks cover local filtering, archived navigation, retained draft/file state, workspace switches,
reload behavior and pointer/keyboard access at narrow widths.

## Limits

- Next uses known metadata and current sidebar order. It does not poll, locate the first unread
  message within a transcript, or monitor other workspaces.
- Filters reset on reload. Read markers and latest-bottom acknowledgement retain ADR 0041's policy.
- File bytes survive in-app navigation only. Reload/closing discards them; selection is required
  again. Existing per-composer limits remain. Many drafts can keep multiple file buckets in memory
  until sent, removed, or the tab closes.
- Narrow navigation remains a horizontally scrollable strip. Keyboard focus reveals controls;
  the command palette provides another route without a new global shortcut.
- At 390 CSS pixels the existing conversation content can still overflow horizontally. The new
  filter and command are usable at that width; this change does not complete the phone layout.
