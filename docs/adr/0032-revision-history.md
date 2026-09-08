# 0032 — Knowledge document revision history

## Context

Knowledge documents are referenced by chat messages, and queued or retried agent invocations can run
long after a file is replaced. Without version pinning, a delayed invocation would read bytes from a
different document than the one the user referenced. Existing local documents also predate any
revision tracking, so their provenance must be captured honestly rather than invented.

Notion-style document version inspection and restore were used as design inspiration; Nexestra keeps
a local-first, permanent history and does not adopt Notion’s retention windows.

## Decision

Every new Knowledge document is created as one immutable revision: bytes are written once
under `workspaces/<workspace>/knowledge/<id>/revisions/<revisionId>` and the item’s `storagePath`
points at that immutable file. The document’s identity, Knowledge id, handle, creation time, and
workspace never change.

Replacement and restore are atomic pointer publications:

1. The server validates upload size/count with the same boundaries as creation before buffering.
2. It checks the current item and rejects stale or unexpected `expectedRevisionId` windows
   (or `legacy` for documents with no recorded history yet).
3. New immutable bytes are written privately, then a cloned next state is written to disk.
4. Only after the state write succeeds is the in-memory state swapped to the next state.

A failed state write unlinks the new revision bytes and leaves both the in-memory item and the
previous revision bytes untouched.

New user messages are pinned at persistence: every Knowledge reference is resolved to the current
document revision, and a legacy document is captured lazily at that moment by copying its existing
  root `document` bytes into its first immutable revision, timestamped at capture time while the
  item’s original `createdAt` stays unchanged. The legacy capture metadata is
published to state before the first transcript event that references it, so a delayed invocation or
a restart after a failed message write still sees the pinned revision. Old messages are never
rewritten. If a legacy item was never pinned before the first replacement, replacement performs the
same lazy capture so the original bytes remain available. Unpinned legacy references still fall back
to the current file, which is the honest documented behavior for references that predate provenance.

Optimistic concurrency uses `expectedRevisionId` on replace and restore. A concurrent
replacement turns a later request into a `conflict` instead of clobbering history. Content
downloads and agent context for pinned references resolve the pinned revision; unpinned/legacy
references resolve the current revision.

Server endpoints:

- `PUT /api/knowledge/:id/document` — replace the current document (multipart upload).
- `GET /api/knowledge/:id/revisions` — newest-first revision list with the current revision id.
- `GET /api/knowledge/:id/revisions/:revisionId/content` — immutable revision download.
- `POST /api/knowledge/:id/revisions/:revisionId/restore` — restore a prior revision as a new
  current version with `expectedRevisionId`.

Deleting a Knowledge document deletes its whole item root, including every revision; explicit
permanent deletion therefore loses history by design and the UI says so in the confirmation.
Versions are never pruned or auto-deleted, and a restore creates a new revision rather than
rewriting history.

## Consequences and gaps

- Immutable bytes are written before the metadata pointer, so a crash between those steps can
  leave an orphan revision file; it is never surfaced as current. A future recovery pass could
  sweep orphans, but none exists yet.
- The legacy root `document` file is preserved after lazy capture, so a legacy item temporarily
  has both the old root file and its captured revision copy. It is retained deliberately; deleting
  it would remove the only evidence of the pre-capture layout.
- Legacy capture publication is a separate durable state write before the transcript append; if the
  message append fails afterward the capture remains, and thread counters rebuild from the
  transcript on the next open.
- `appendMessage` appends the transcript and then writes thread counters; the counters and API
  response can fail after a durable message exists, and the counters rebuild from the transcript on
  the next open. The transcript writer itself is append-only, so it does not automatically produce
  duplicate events.
- History is stored as full copies of each upload, not deltas, and is bounded only by explicit
  user deletion and the configured upload caps.
- Revision metadata (`createdAt`, file name, media type, size, sha256, optional
  `restoredFromId`) can drift if local on-disk bytes are modified, but downloads verify sha256 and
  return `invalid` rather than serving corrupted bytes.

## Validation

Store tests prove revision pinning at persistence, lazy legacy capture before first replacement,
durable legacy capture when a message state write fails after the transcript append, replacement and
restore provenance, stale/foreign/missing revision rejection, and replacement rollback on state-write
failure with unchanged in-memory and on-disk current bytes. Dispatcher tests prove that a queued
invocation and a retried failed run keep the message’s pinned revision after a replacement. HTTP
tests cover replace, revision list/download, restore, stale conflicts, and pre-buffering upload
rejection. App tests cover the replace/restore UI, error states, and pending guards.

## Status

Accepted for Milestone M9.
