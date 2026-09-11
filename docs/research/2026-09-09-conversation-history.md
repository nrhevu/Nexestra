# Research: bounded conversation history

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Problem and evidence

Transcript search already bounds its scan and response. Opening a result still fetched and rendered
the complete conversation at the start of this work. The same full request ran again for durable
SSE updates. A long thread therefore imposed a cost even when the reader wanted one old message.
This gap was recorded in the [search report](2026-09-09-transcript-search.md).

[Node.js FileHandle.read](https://nodejs.org/docs/latest-v24.x/api/fs.html#filehandlereadbuffer-offset-length-position)
accepts a byte position and reports the number of bytes read. An explicit position leaves the
handle's current position unchanged. This permits reading selected JSONL records by byte offset.
Short reads still need a loop, and positions must refer to bytes rather than JavaScript characters.

[MDN's Intersection Observer documentation](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API)
describes asynchronous visibility observation, including infinite-scroll use cases, and notes that
callbacks run on the main thread. An observer can control when to fetch but does not itself cap the
number of retained message nodes. Nexestra's choice of finite pages is a design decision, rather
than a recommendation attributed to that documentation.

The web-search tool returned HTTP 404. Both official pages were fetched directly over HTTPS and
read locally. This research did not use a provider or third-party search service in the product.

## Selected scope

Use a 50-message window in the browser, with explicit older, newer and latest navigation. Open a
stable message link by requesting a page around its ID. Missing-target status must come from a
lookup across the indexed conversation, not from absence in the current window.

Keep the canonical JSONL as the only durable transcript. Build an in-memory index of record byte
positions during startup and maintain it after durable appends. Read page messages, their artifacts,
and the latest relevant run/tool records at those positions. A bounded suffix cannot establish
the final state of an old run: its last update may be arbitrarily far from the trigger message.

Return whole-thread active runs separately, using the same dispatcher projection as bootstrap.
Historical pages reload their existing anchor on durable SSE updates, so their run/tool state can
change without replacing the page with the newest messages. Late responses from an earlier page,
thread or workspace must not replace the current selection.

Use a metadata-only lookup to resolve a foreign-workspace thread URL. Load the full existing
Files & links inventory only when the reader explicitly opens that tab, retaining old files and
their attribution. The legacy full-thread API, exports and runtime context remain available.

## Acceptance and verification

The backend, UI and attention navigation are integrated. The combined `pnpm check` passes lint,
type checking, all 446 tests in 34 files, and the browser/server production builds. Acceptance
checks cover finite page boundaries, old linked targets, missing IDs,
non-ASCII byte offsets, late run/tool updates, append/restart consistency, failed metadata writes
after durable appends, stale UI requests and full old artifacts.

An isolated local API fixture contains 1,200 messages in an active thread and 160 in an archived
thread, with original uploads and links on early pages. Walking all 24 pages of the active thread
returned exactly the same 1,200 distinct messages as the legacy full response, including Unicode
and embedded Markdown newlines. Older/newer traversal, a centered target at message 120, missing
targets, invalid cursor combinations and foreign-workspace rejection passed.

The legacy response was 1,185,610 bytes; the default 50-message response was 49,987 bytes, a 95.78%
reduction for this fixture. The metadata-only lookup was 310 bytes. These are measured response
sizes, not a general latency benchmark. The oldest page retained both original artifacts. SHA-256
hashes of all five fixture data files (state, two transcripts and two uploaded files) were unchanged
after the read-only API checks. No provider was invoked.

Native browser checks on the isolated fixture opened the original upload and link inventory,
including author attribution, resolved an archived message link from another workspace, and showed
an explicit missing-target notice. A local fake agent requested approval at message 1,201; after
60 ordinary notes moved its trigger outside the latest window, Needs attention still exposed the
request. Open run selected the trigger on messages 1,177–1,226. Approving it cleared the attention
badge and kept that historical range while the total grew to 1,262. Each view retained 50 message
sections. These interactions used a fake runner; no provider or shell command was executed.

A second fake run finished while Files & links was open on a historical page. Its generated link
appeared automatically, increasing the inventory from three to four entries with the correct
agent attribution. Returning to Messages retained the same 1,164–1,213 range after the total grew
to 1,264, and the Running badge cleared. Final browser checks on the integrated branch confirmed
readable light/dark theme colors and a fully visible, focused linked message after reload. The
15 history UI tests include delayed page requests, quiet refresh failures, StrictMode Markdown
layout changes and stopping automatic positioning after user input.

## Deliberate limits

- Startup still scans the history. The in-memory index consumes metadata proportional to record
  counts and can be rebuilt from JSONL; this is not a constant-memory database. Startup currently
  makes multiple full passes, and anchored-page lookup scans the in-memory message index.
- Message windows bound rendered history, but related records and unusually large legacy events
  also require explicit byte limits. Oversized pages must fail visibly rather than omit status.
- Files & links, Markdown exports and agent context still use the full-thread read path. They are
  separate from opening and paging through Messages. The UI caches a full inventory for one thread.
- The UI uses a fixed 50-message page. It reports over-budget pages as errors; smaller limits are
  available through the API, but there is no page-size selector in this version.
- Linked-message positioning waits for lazy Markdown within a 180-frame cap and stops on user
  input. Images loaded later can still change row height.
- This does not add virtualization, content search syntax, transcript compaction or persisted
  secondary indexes. Browser navigation is not a snapshot of a conversation that can keep growing.
