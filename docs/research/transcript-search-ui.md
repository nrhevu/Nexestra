# Transcript message search UI behavior note

- Standalone modal owned by MessageSearchDialog.tsx; root wires mounting, workspace keying, and message navigation.
- Client sends GET /api/search/messages with workspaceId, q, optional threadId, archived=all|active|archived, limit=50, optional offset.
- Empty queries never request. A nonempty initialQuery auto-searches once on mount.
- Results are plain-text rendered buttons (never HTML); snippets come from the server already bounded and redacted.
- matchesFound is observed-only; complete=false surfaces a partial-scan warning and never claims a global no-match result. Results may be incomplete even within one thread (budgets, unreadable/torn content), so the copy suggests narrowing without promising completeness.
- Paging is offered only when complete=true and nextOffset is present; appended pages are deduplicated by threadId/messageId so live-offset overlap is not shown twice.
- Editing the form clears results, errors, and pending state and invalidates in-flight requests; the next Search submits the current fields.
- Every new submit, form change, workspace change, and unmount invalidates pending requests via AbortController and a monotonic request id; late responses are discarded.
- onClose is kept in a ref so parent rerenders do not steal focus from filters/results.

