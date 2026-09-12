# Bulk review Knowledge capture research — 2026-09-12

## User problem

Needs-work review is a deliberate quality loop: a person revisits a bounded response, sees the
canonical source, and decides whether it deserves a named Knowledge item. Once a page contains
several useful responses, repeating the same navigation and dialog setup becomes the main cost.
The shortcut must not turn a redacted queue excerpt into durable content or remove the naming step.

## Chosen slice

The review page now offers **Capture selected** for visible rows. The App queues those projections
in page order and reuses the existing capture dialog. Each submit calls the existing
`/api/knowledge/from-message` endpoint with the stable thread and message IDs; the server rereads
canonical JSONL bytes and writes provenance. Names and handles remain editable for each item.

The queue owns selection cleanup. It removes only IDs returned after confirmed saves. If the user
closes the dialog or a subsequent save fails, previously confirmed IDs are returned while the
remaining rows stay selected. Filters and pagination remain page-scoped and are never expanded by
the bulk action.

## Known gaps

The in-memory queue is intentionally lost on reload or workspace navigation. Bulk capture does not
resolve review status, deduplicate similar Knowledge, or provide a hidden-page “select all”; each of
those needs a separate policy and bounded UI. A future server-side batch endpoint would need an
idempotency and per-item result contract before replacing the sequential dialog.
