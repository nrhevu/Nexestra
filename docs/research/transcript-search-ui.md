# Transcript message search UI behavior note

- Standalone modal owned by MessageSearchDialog.tsx; root wires mounting, workspace keying, and message navigation.
- Client sends GET /api/search/messages with workspaceId, q, optional threadId, archived=all|active|archived, limit=50, optional offset.
- Empty queries never request. A nonempty initialQuery auto-searches once on mount.
- Results are plain-text rendered buttons (never HTML); snippets come from the server already bounded and redacted.
- matchesFound is observed-only; complete=false surfaces a partial-scan warning and never claims a global no-match result.
- nextOffset is used only when present; pagination appends to results under the same submitted query/filter.
- Every new submit, form change, workspace change, and unmount invalidates pending requests via AbortController and a monotonic request id; late responses are discarded.
- After results are shown, editing the form marks them stale until Search is pressed again; they are never silently presented as matching the new form.
