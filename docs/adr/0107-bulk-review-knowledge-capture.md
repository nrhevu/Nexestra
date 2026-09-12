# ADR 0107: Sequential bulk capture from the Needs-work queue

- Status: Accepted
- Date: 2026-09-12

## Context

The Needs-work surface already lets a user inspect a canonical reply and deliberately capture it as
Knowledge. Capturing several reviewed replies required reopening that action one row at a time and
made it easy to lose track of which rows had been confirmed. Automatic promotion would skip the
review and naming decision that protects Knowledge quality.

## Decision

Add a page-scoped **Capture selected** action. The browser passes the selected queue projections to
the App, which opens the existing capture dialog for one canonical message at a time. The user must
review and submit the name, handle, and optional description for every item. After a confirmed
server response, the next item opens. The server remains the source of truth: it rereads each
thread/message pair and records provenance exactly as the single-item flow does.

Selection is cleared only for IDs whose capture request completed successfully. Closing the dialog
or a later request failure resolves the batch with the successful IDs, leaving the remaining visible
rows selected so the user can retry them. The flow is limited to the currently loaded page; it does
not fetch hidden rows, resolve review status, or auto-edit captured content.

## Consequences

- Knowledge promotion stays explicit and provenance-preserving while reducing repetitive navigation.
- Partial failures are recoverable without silently dropping work.
- The App owns the small in-memory queue; no credentials, queue state, or message content is added to
  persisted state or transcripts.
- A browser refresh or workspace switch abandons the in-memory remainder. Already confirmed captures
  remain durable and are returned to the queue for selection cleanup.
