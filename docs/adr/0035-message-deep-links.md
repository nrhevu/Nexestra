# 0035 — Stable message links and focused conversation navigation

## Status

Accepted for Milestone M9; history loading amended by
[ADR 0038](0038-bounded-conversation-history-pagination.md).

## Context

Transcript search needs to open the matched message, including in an archived conversation. Opening
only the thread would immediately scroll to its latest content and leave the user to find the match
again. Thread names can change, and a link can be opened while another workspace is selected.

## Decision

Message links use `/threads/<thread-id>?message=<message-id>`. Both IDs are stable stored identities;
thread names and slugs are never used to locate a message. The message query is optional, so existing
thread links keep their behavior. The existing foreign-thread lookup resolves the owning workspace
before rendering a target, including archived threads.

The route carries a fresh message-target object for each navigation. The conversation switches to
Messages, highlights the matching group and focuses it once it is available. New transcript updates
do not pull the view to the bottom while a message target is selected. **Show latest** removes the
query and resumes ordinary latest-message scrolling. Selecting the same result again is a new
navigation, so it can reopen the Messages tab after the user viewed Files & links.

A missing message shows an explicit notice and a Show latest action; another message is never
highlighted as a substitute. An ordinary workspace switch clears the old message target. Resolving
a foreign message link retains the target, since that switch belongs to the link itself.

Message links, highlighting and focus are view state. They do not append events, change thread
metadata, restore archived threads or dispatch agents. Draft handling stays thread-scoped.

Saved message rows expose **Copy message link**, including archived conversations and older pages.
The action builds an absolute URL from the current origin and the stored thread/message IDs,
discarding unrelated current query parameters and fragments. It reports success only after the
asynchronous clipboard write resolves. Unavailable or denied clipboard writes reveal a selectable
URL for manual copying. Feedback belongs to the row's component state and is not persisted.
Pending actions use `aria-disabled` with an activation guard to preserve keyboard focus while
the clipboard promise settles. A manual field takes focus only when the user is still on its
copy button; a delayed error cannot pull focus away from the composer. Metadata and manual-copy
controls wrap within the message pane.
This extends the same route; it introduces no public sharing service or server mutation.

## Validation and limits

Focused UI tests cover active/archived links, selected-message focus, Show latest, another message
in the same thread after changing tabs, missing targets, foreign archived links and ordinary
workspace switches. Search-to-message tests also cover selecting the same archived result again
after opening Files & links. Native-browser verification confirmed a search hit halfway through an
archived conversation is centered and focused, survives reload, resolves from another workspace,
and exits to latest messages without changing the transcript.

Copy-link acceptance adds five component and two route integration tests. Native checks cover an
old page, a renamed archived thread, foreign-workspace reopening, keyboard copying, unchanged
transcript bytes, and simulated delayed denial in a narrow pane. The integrated gate passes all
521 tests plus lint, types and build. See the
[copy-link research record](../research/2026-09-09-copy-message-links.md).

- The initial implementation loaded a full transcript. ADR 0038 replaces message loading with a
  finite page around the linked ID and a metadata-only foreign-workspace lookup. Rendering remains
  a finite page, without continuous transcript virtualization.
- Focus selects the message group, not a substring inside formatted Markdown. Media loaded later
  can change row height; browser verification must check the actual selected message is visible.
- External malformed message IDs longer than 200 characters are ignored by the route parser.
- Copied links require the same local server and data directory. They do not transfer or publish
  message content; changed origins or missing local data can make a saved link unavailable.
