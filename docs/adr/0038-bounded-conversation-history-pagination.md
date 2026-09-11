# ADR 0038 - Bounded conversation history pagination

## Status

Accepted for Milestone M9.

## Context

Thread transcripts are append-only JSONL files under `.nexestra/threads/`. The
existing `threadData`/`readEvents` path loads an entire transcript on every call,
which is correct for runtime tasks, exports, and Files-tab access but does not
scale for browsing very long conversations. A history page needs the latest
messages, an older/newer page around a known message anchor, or a page centered
on a target message without reading the whole file per request.

## Decision

- Add `GET /api/threads/:id/history?workspaceId=...&limit=...&before|after|around=<messageId>`
  returning `ThreadHistoryPage` (a `ThreadData` projection plus whole-thread
  `activeRuns` from the dispatcher and page metadata). `before`/`after` anchors
  are mutually exclusive; an unknown `before`/`after` anchor is an explicit 400.
  An unknown `around` anchor returns the latest window with `targetFound:false`
  and an explicit missing-target notice in the browser.
- Add `GET /api/threads/:id/metadata` returning a redacted `Thread` for any
  existing thread ID. Unlike the history endpoint it intentionally does not
  require `workspaceId`, because its purpose is resolving a thread when the
  client does not yet know which workspace it belongs to. It performs no
  transcript I/O.
- Keep the legacy full `GET /api/threads/:id` and export endpoints unchanged;
  the UI requests full data explicitly for Files & links and retains only the
  most recently opened full inventory. Its count changes refresh an open tab.
- Render finite windows of 50 messages. Older/newer replace the window, Show latest
  clears a linked target, and `around` focuses the target after lazy Markdown settles.
  Historical SSE/poll refreshes keep the selected anchor and cannot supersede a
  pending explicit page request. Needs attention opens the run's trigger message.
- Prime an in-memory byte-offset index (`src/server/conversation-history.ts`)
  for every thread during `FileStore.open`, as an additional startup pass; startup already performs other full passes (tail repair, summary repair, interrupted-run recovery), so this is deliberately not a single-scan optimization.
  Messages and artifacts are ordered by sequence; run and tool events keep only
  the latest state per run/toolCall, selected by highest sequence then last
  physical offset. The index retains only short IDs, sequence numbers, and byte
  offsets: `O(record count)` metadata memory, documented as intentional.
- Maintain the same index after every durable append (`message.created` +
  artifacts, `run.updated`, `tool.updated`) while the write queue is held, with
  the identity snapshot updated from the file after `fsync`. A thread created
  but never written has a valid empty index; its first durable append upgrades
  that index without a whole-file re-read.
- History reads are positional (`FileHandle.read` at recorded offsets) and run
  inside the store write-queue barrier, so an own concurrent append cannot be
  misclassified as an external change. The opened handle is fstat-verified
  before and after the reads against the captured identity (device, inode, size,
  mtimeNs, ctimeNs).
- External truncation, replacement, or in-place edit while the process is open
  returns an explicit 409 with restart/reload guidance instead of a silent
  fallback full-read or a falsely complete page. External editing while running
  is an unsupported, detected condition.

## Budgets and limits

- Page limit: 1-100 messages, default 50.
- Per event line: 1 MiB; per page: 8 MiB of selected raw JSONL bytes, before redaction. Pages that
  would exceed either fail explicitly rather than silently omitting content.
- Startup performs multiple full passes over every transcript (tail repair, summary repair, history-index priming, interrupted-run recovery);
  per-request transcript reads are bounded by the page limits above. Anchor lookup
  still scans the in-memory message index, so total CPU cost is not constant.
- The transcript itself is never copied, indexed to disk, or mutated by these
  endpoints, and no provider is invoked.

## Integrity and redaction

- Unknown well-formed event types are ignored without making the index
  unreliable. Malformed, oversized, invalid-UTF-8, or torn-tail lines make the
  thread's history index unreliable: history requests for that thread fail
  explicitly (409) and legacy full endpoints keep their existing behavior.
  Torn tails without a trailing newline are always counted as torn even if the
  JSON happens to parse; startup tail repair normally removes them first.
- All returned content, author/thread/artifact metadata, tool inputs, and
  run/tool errors pass through the existing `redactSecrets` pipeline with
  schema-safe clipping and handle placeholders, so stored credentials never
  leak through history pages or metadata.
- `activeRuns` is captured at request start (before the awaited positional
  reads) so a run that finishes during the read still keeps the UI stream alive
  for the next reload instead of falsely removing the final refresh.

## Testing

- No whole-file read per page (including the first request after open), no
  `readEvents` call, read-only transcript hashes.
- latest/before/after/around continuity with no gaps/duplicates after appends;
  >512 run/tool updates resolve to canonical final state.
- First append to a startup-empty thread, concurrent page+append serialization,
  external-edit 409, workspace isolation, unknown anchors, around fallback,
  malformed/oversized/invalid-UTF-8/torn/unknown fixture classification, and
  credential redaction, empty-thread before/after/around semantics, externally
  created missing-file conflicts, blank/whitespace-line fixtures, same-size
  rewrite detection via mtimeNs/ctimeNs, physically out-of-order latest run/tool
  state, page-byte-budget rejection, restart no-rescan, and recovered durable
  appends after state-write failure.
- HTTP metadata with no transcript I/O, foreign-thread resolution, and
  thread-scoped dispatcher `activeRuns`.

## Known limits

- External transcript edits while the process is running are rejected with 409;
  they require restart/reload.
- Index memory is `O(record count)` and startup performs multiple full passes.
  Finding an anchored page is linear in the number of indexed messages; page
  payload bounds do not make startup, metadata lookup, or all browser memory constant.
  File identity (device/inode/size/mtimeNs/ctimeNs) is an honest change
  detector, not cryptographic proof: same-size rewrites with a restored
  millisecond mtime are detected through nanosecond and ctime differences in
  practice, but a determined external editor that restores all metadata can
  still defeat it; external edits while running are unsupported.
- A page that exceeds byte/event budgets fails explicitly. The browser currently
  requests 50 messages and has no smaller-page selector; a smaller limit is
  available through the API, and exports retain the legacy full read path.
- The linked-message layout watcher stops after 180 animation frames or real user
  input. Images or pathological layouts that grow after it stops can move content.

# Notes

- `activeRuns` snapshot-at-request-start and `withWrite` barrier cover known
  races without weakening the canonical transcript contract.
