# 0025 — App-scoped draft and last-thread browser state

## Context

The composer persisted drafts directly from a component effect under a thread-only key. A view
remount could read a restored draft while an empty hydration effect still held the old value, and
any browser storage exception escaped to the effect boundary. Draft text also lived in one thread
context even when two workspaces happened to share a thread ID, and the browser reopening a
thread could not restore the exact conversation the user had been working in.

## Decision

Own an in-memory `ConversationState` at the `App` root, keyed by `workspaceId:threadId`. It reads
at first access, never writes during hydration, applies every keyboard change synchronously through
guarded `localStorage` calls, and clears a draft only after a successful send matches its revision.
The empty scoped value is persisted as a tombstone, so a pre-workspace `nexestra.draft.<threadId>` key
cannot resurrect text that was already sent. Loads of the old thread-only key remain as a display fallback.

The sidebar marks thread rows with a **Draft** badge while any nonempty draft exists. The browser
also remembers the last opened thread per workspace; opening Threads returns to that conversation
when it is still listed. A bare `/threads/:id` URL whose thread is absent from the current
bootstrap is resolved with one `GET /api/threads/:id`, which returns the owning `workspaceId`; the app switches
to that workspace before route fallback runs, and a missing thread falls back through the same per-workspace history.

Theme and workspace selection move through the same guarded browser storage helpers, so a denied
storage area cannot crash startup. When persistence is unavailable, the composer keeps text in
memory, the draft badge still reflects it, and the composer shows a temporary in-tab note.

## Consequences

Drafts survive view switches and normal reloads without server involvement, failed sends keep the
text for correction, and restoring a thread no longer depends on effect ordering. Draft revisions
are monotonic: clearing and retyping during an in-flight send advances the revision, so an older
acknowledgement can never clear newer text. Drafts remain
browser-only and are not part of the canonical transcript. The in-memory map is per tab, so another
tab writing the same key is only observed at its next fresh read after the value is not live in
this tab; this matches the single-user, local-first boundary and adds no server round trips.

## Status

Accepted for Milestone M9. Extends the browser state handling documented in ADR 0003.
