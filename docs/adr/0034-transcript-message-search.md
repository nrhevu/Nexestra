# 0034 — Server-side transcript message search

## Context

The web TopBar previously searched bootstrap metadata for threads, tasks, agents and Knowledge.
A user who remembered a phrase inside a message had no way to rediscover it. Nexestra keeps one canonical JSONL transcript
per thread under the data directory, and messages are append-only. Search must stay local-first
and read-only: no index, no transcript copies, no provider invocation, and no mutation of
transcripts or state.

Slack's search UI narrows remembered messages by conversation and author; Nexestra adopts the
narrowing idea (thread and archive filters) but deliberately does not copy Slack's query language.
Search is a plain, case-insensitive literal substring match over redacted message.created content.

## Decision

Add GET /api/search/messages scoped to one workspace:

- workspaceId (required), q (trimmed literal, 1..200 chars), optional threadId,
  archived=all|active|archived (default all), limit (default 50, max 100), offset
  (default 0, max 10_000).
- Unknown workspace or a threadId that is not in that workspace returns 404.
- The server streams each filtered thread's canonical transcript with bounded memory and returns
  matching message IDs, sequence, stable thread id/name/slug/archive state, author, createdAt,
  and a bounded redacted context snippet. No full message content is returned or retained; the UI
  opens the canonical transcript for full content.
- matchesFound is the number of matches observed inside the scanned region. It is exact only when
  complete is true; it is explicitly not a global total for partial scans.
- complete is true only when every filtered thread file reached EOF with no scan budget hit, no
  missing/unreadable file, no malformed/torn/oversized line, and every matching record carried
  search-safe metadata (bounded IDs/names and a valid ISO timestamp). Ignored well-formed
  non-message/unknown events do not affect completeness.
- nextOffset is returned only for complete scans when more matches remain, and only while the
  next page offset stays within the accepted request cap (10_000). Scan-limited or partial scans
  never advertise continuation; callers must narrow by threadId/archived or use a more specific
  query.

Budgets and diagnostics:

- Total scan bytes 50 MiB, total scanned lines 200k, per-line max 1 MiB, result window capped at
  offset + limit (max 10_100). Budgets are exported and internally overridable for tests.
- diagnostics reports threadsScanned, linesRead, bytesRead, messageEventsSeen, malformedLines,
  tornTailLines, oversizedLines, missingFiles, unreadableFiles, scanLimited, and scanLimit.
  Missing files on never-used threads (no transcript yet, messageCount 0, lastMessageAt null) are
  expected and do not make a search partial; missing/unreadable non-empty history does.

Secrets and metadata safety:

- Matching runs on redactSecrets(message.content); a query containing a full stored credential
  matches nothing and echoes [REDACTED]. The echoed term is clipped to 200 chars after redaction.
  Thread name/slug and author name/handle are redacted before display, and the search hit author
  schema accepts redacted display text instead of re-validating handle/name constraints.
- Snippets are built from redacted content, capped at 300 chars, and copied to a fresh string so a
  retained hit never keeps a whole large line alive. IDs (200), names (512), and createdAt
  (ISO, 40) are bounded in the search hit schema; records that cannot form usable links are
  skipped and mark the scan partial, never crashing the stream callback.

Streaming reader:

- A custom UTF-8 line reader enforces byte and line budgets per file, drops over-1 MiB lines
  without buffering them, detects torn tails by tracking the final byte, and reports ENOENT
  separately from other read errors. Lines are decoded with a fatal UTF-8 decoder, so invalid
  bytes are counted as malformed/partial instead of being silently replaced. Line parse failures
  are counted and skipped instead of throwing like the mutation path's readEvents. The scanner
  never writes to transcripts, state, or credential files.

## Consequences and gaps

- Search is literal substring only: no stemming, synonyms, regex, or Slack-style query operators.
  Case folding is the JavaScript default (toLowerCase), which covers common scripts but not every
  Unicode case-mapping edge.
- There is no index, so every search is a bounded full scan of the filtered transcripts. Large
  workspaces may hit byte/line budgets; responses then report complete false and the caller
  should narrow the query.
- Retrieval is capped at offset 10_000. Beyond that, pagination stops (no unusable nextOffset);
  reaching older matches requires narrowing by thread/filter or a more specific term.
- Malformed, torn, oversized, or metadata-unsafe lines make the scan partial by design rather
  than silently claiming full results; a single bad line therefore defeats complete even when
  most of the workspace matches.
- Offline/missing history for non-empty threads is detected per thread; an offline file is
  reported only through complete false and diagnostics counters, never through paths or raw
  errors.
- Author/thread display fields are redacted for credentials but are not otherwise normalized;
  redaction can expand names, so search-safe bounds are generous display limits rather than the
  stricter creation constraints.

## Validation

Store tests cover active+archived filters, rename identity, workspace isolation and foreign
thread rejection, case-insensitive phrase/snippet behavior, malformed/torn/oversized line
accounting, invalid UTF-8 line handling with unchanged valid Unicode and CRLF behavior,
byte/line budgets, pagination only on complete scans, the offset cap, never-used threads,
missing/unreadable history, read-only invariants, credential redaction in query/snippet/metadata,
redacted handles that coincide with credentials, and metadata-unsafe hits. HTTP tests
cover query validation, 404/400 behavior, response shape without provider invocation, and HTTP
credential echo redaction.

## Status

Accepted for Milestone M9.
