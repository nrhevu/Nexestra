# 0036 - Bounded plain-text preview for Knowledge documents

## Status

Accepted for Milestone M9.

## Context

Knowledge documents store full immutable bytes and users frequently need to check what a version
contains before downloading or restoring it. Opening the file in an external viewer is heavyweight,
and rich rendering of uploaded Markdown/HTML would add markup parsing, resource loading, and
script-surface handling that a local file read does not need. This feature deliberately uses plain
text for that read. The design goal is a read-only, bounded preview that never changes
document history, never exposes storage paths, and never treats upload text as HTML.

GitHub's file viewer separates raw content inspection from history/download actions, and MDN's
Node.textContent semantics describe plain text nodes without markup parsing. Nexestra applies
those ideas as a deliberate local-first constraint: upload text is always rendered as plain text.

## Decision

GET /api/knowledge/:id/preview returns a typed KnowledgeDocumentPreview payload:

- revisionId, isCurrent, fileName, mediaType, size, sha256, createdAt, supported, text,
  truncated, and reason fields follow the shared Zod schema.
- With revisionId, the server reads that immutable revision; without it, the current revision is
  used, or the legacy root document when no revision metadata exists yet. The endpoint is strictly
  read-only: it never invokes providers and never lazily captures a legacy document, so a preview
  cannot invent revision metadata or change state.
- Text-capable media types (text/*, JSON, YAML, XML) are previewed; binary/media files return
  supported:false with a reason and the UI offers the same download fallback used by
  unsupported UTF-8 content.

Bounds and integrity:

- A preview bounds the source bytes retained for the returned text to the first 128 KiB (plus a
  bounded credential lookahead while scanning and normal stream buffers). utf8SafeBoundary keeps
  an intact final multibyte character when it fits and cuts a split character at a character
  boundary so the source text is valid UTF-8 and never exceeds the budget. Redaction can expand
  the returned string slightly (for example a short legacy credential becomes the longer
  [REDACTED] marker), so the returned payload is not guaranteed to be at most 128 KiB even though
  the underlying previewed bytes are.
- The total number of bytes read from disk is bounded by the existing upload cap
  (MAX_UPLOAD_BYTES). Files larger than the cap (including files grown after creation) are
  rejected as too large; a bounded stream read of cap+1 bytes detects growth between stat and the
  end of the stream, so a prefix hash is never treated as whole-file verification.
- For revisions with a recorded checksum, the full revision sha256 is verified before any preview
  text is returned. Corrupted bytes produce an integrity error even when the same bytes are not
  valid UTF-8; only after the checksum passes is invalid UTF-8 reported as an unsupported preview.
- Legacy unpinned documents have no recorded checksum yet; they are still bounded and are read
  without inventing provenance.

Redaction:

- Stored credentials (credentials.json) are redacted from preview text and from the returned
  fileName/mediaType labels on both supported and unsupported paths.
- A credential that straddles the 128 KiB cutoff cannot leak a prefix: the helper retains a bounded
  lookahead window large enough for credentials accepted by normal creation validation (up to
  4,096 code points, at most 4 UTF-8 bytes each) plus a character overread, finds the earliest
  credential occurrence that starts before the output boundary and ends after it, and cuts the
  returned text before that occurrence. previewText.length is the UTF-16 boundary marker because
  indexOf and credential lengths use UTF-16 code units, not code points.
- Legacy credential files are still accepted regardless of value size so existing stores keep
  opening. If any stored credential exceeds the bounded lookahead, previews return supported:false
  with no text and the UI's download fallback, because split-secret redaction cannot be guaranteed
  safely.

UI:

- The detail dialog embeds a preview panel (not a stacked modal) with an explicit Preview current
  button and a Preview button on every history row, an accessible bounded reading area,
  filename/version context, truncation notice, and loading/error/retry/unsupported states.
- The selected-version Download link always matches the version being previewed, and unsupported
  previews show the same download fallback instead of content.
- Preview text is rendered inside a pre node only; uploaded HTML, scripts, Markdown images, PDFs,
  and remote content are never parsed or embedded.
- Requests are aborted and old preview state cleared when the user switches versions, replaces or
  restores, changes workspace/document, or closes the dialog; a stale response can never overwrite
  the newer or reopened view.

## Consequences

- Users can read current and historical versions without downloading them, with honest truncation
  notices and version context.
- Reads from disk are bounded by the upload cap, and retained source bytes are bounded by the
  128 KiB preview budget plus credential lookahead and stream buffers, even for tampered oversized
  files. The UI's truncation notice refers to the 128 KiB source preview budget.
- Full immutable bytes and revision metadata are unchanged by previews; the endpoint never mutates
  state or provider state.

## Known gaps

- Plain-text preview has no syntax highlighting, rendering, search, or pagination; the first
  128 KiB is shown with a truncation notice and download fallback.
- Legacy documents without captured history have no checksum to verify yet.
- Oversized legacy credentials (beyond the creation limit) disable plain-text preview until the
  credential is rotated or removed; metadata redaction and downloads still work.
- The bounded lookahead cuts before a straddling credential, so a small amount of preceding
  text may be omitted from a truncated preview rather than shown with an unredacted prefix.
- Preview content is local text only; binary formats such as PDF and Office formats are not
  rendered or parsed.

## Validation

Store tests cover bounded current/historical previews, an intact final multibyte character, a split
character at the 128 KiB boundary, the upload-cap overflow rejection, checksum corruption before
invalid UTF-8, metadata redaction, split-credential redaction with an astral character before the
cutoff, legacy unpinned preview without state writes, and unsupported/missing/foreign previews.
HTTP tests cover the preview contract end to end plus a tampered revision returning an integrity
error, with no state writes and no provider invocations. Component tests cover plain-text-only
rendering, version selection and download links, unsupported fallback, retry, and stale-response
abort on version, document, workspace, replace/restore, and identity changes. Integration tests in
the detail dialog cover current and historical preview flows.
