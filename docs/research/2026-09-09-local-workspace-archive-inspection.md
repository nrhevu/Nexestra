# Local workspace archive inspection — research and QA, 9 September 2026

## Why this idea

Portable export now records the bytes it delivers, but checking a saved ZIP still requires external
tools. A local inspector lets users compare its actual contents with the manifest before keeping
or sharing the artifact. This follows the export research's suggestion to begin archive handling
with a read-only report. It deliberately makes no import or restore promise.

## Primary sources

- [PKWARE ZIP specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT), sections
  4.3.7, 4.3.9, 4.3.12 and 4.3.16, defines the local header, data descriptor, central directory and
  end record. Checking these together identifies payload boundaries and conflicting archive views.
  The parser supports signed and unsigned non-ZIP64 descriptors, using record boundaries to avoid
  confusing a CRC value with the optional descriptor signature.
- [MDN: Using Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers)
  describes module-relative Worker construction, message passing and termination. A dedicated
  Worker gives this local operation a separate execution context and an explicit cancellation
  boundary. The 45-second client deadline and request-generation guards are Nexestra decisions.
- [MDN: SubtleCrypto.digest](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)
  documents SHA-256 and states that input is not streamed. The implementation therefore buffers
  one capped entry per digest and keeps this memory limit explicit.
- [fflate's official README](https://github.com/101arrowz/fflate#readme) documents stored streaming
  ZIP entries. Nexestra's existing exporter uses that profile; supporting it without decompression
  gives an explicit compatibility boundary for this inspector.

The web tool returned a transport 404. The official pages were fetched directly over HTTPS and read
on 9 September 2026. The format limits and the decision to keep all inspection local are application
design choices, not claims prescribed by those sources.

## Implementation

Three subagents implemented the shared ZIP integrity engine, Worker/client lifecycle and inspection
dialog. Root implemented Settings/command integration, acceptance tests, fixtures, review,
documentation and native browser QA. The contract is in
[ADR 0047](../adr/0047-local-workspace-archive-inspection.md).

Opening or choosing a ZIP is inert; Check ZIP starts one cancellable operation. Success identifies
the archive's own workspace and lists verified payloads, paginated at 50 entries. There is no upload,
workspace mutation, secret scan, extraction, import or restore action.

## Verification record

- `pnpm check` passes with Node 26 and `NODE_OPTIONS=--no-experimental-webstorage`: Biome checks
  127 files, TypeScript passes, **790 tests in 56 files** pass, and client/server builds finish.
  This adds 54 acceptance tests to the export baseline. The checks use the actual integrated
  engine, runtime and dialog; no temporary client/engine stub is present in the integration tree.
- The 15 engine tests cover real exporter output, stored entries with no descriptor or signed/
  unsigned descriptors, Unicode names, empty transcripts, binary bytes, conflicting headers,
  duplicate/traversal/BOM paths, corruption, manifest coverage, unsupported ZIP features and
  advertised limits. Cancellation tests cover pre-abort, an immediately cancelled queued read,
  stalled reads, late digests and the 30-second deadline. Invalid Blob sizes are rejected before
  slicing, and a short read cannot be counted as a complete payload.
- The 24 Worker/client tests cover File-only messaging, unavailable Workers, malformed and stale
  replies, a constructor-time abort, progress validation, error forwarding, observer exceptions
  and cleanup. A simulated stalled Worker is terminated at the 45-second client deadline. The
  native checks below exercise manual cancellation; they do not claim to reproduce a real browser
  I/O stall lasting 45 seconds.
- The 12 dialog tests and 3 navigation/command tests cover inert opening/selection, explicit start,
  cancellation/retry, unsupported input, pagination, fallback errors, keyboard focus, draft/files
  preservation and workspace-switch rejection of stale results. The existing App and TopBar suites
  also pass against the combined changes.

An independent harness inspected ten ZIP variants with **34 assertions**, including Python-created
corrupt/repacked variants and two archives produced by the real server exporter:

| Fixture | Observed result |
| --- | --- |
| Real export, 36,322 bytes | 8 verified payloads; 32,094 payload bytes |
| Real export with 61 threads, 48,751 bytes | 63 verified payloads; 23,082 payload bytes |
| Changed upload byte | CRC integrity failure with the validated upload path |
| Changed NOTICE manifest hash | SHA-256 mismatch at `NOTICE.txt` |
| Deflated/recompressed archive | Unsupported compression |
| Added traversal entry | Invalid path, without echoing the unsafe name |
| Empty file and plaintext `.zip` | Invalid archive structure |
| Repacked archive with a 120 MiB upload | 8 verified payloads; 125,864,966 archive bytes |
| 137 MiB file | Size limit failure before any slice/read |

The large fixture replaces a payload and updates its manifest hash; it is an integrity test fixture,
not evidence that the altered state metadata can be restored.

Native browser QA used an isolated FileStore and a runner that counts and rejects invocations.
The native file chooser passed actual Files into the real module Worker, first through Vite and then
through production assets served by Hono. Production returned the compiled Worker asset with HTTP
200, accepted the real export, rejected the corrupted upload and supported cancellation/reselection.
The ZIP parser is present in the Worker bundle and absent from the main bundle.

- Empty and oversized selections show an error without starting inspection. Selecting a valid ZIP
  waits for Check ZIP. Both Settings and the command palette open the dialog.
- The foreign-workspace archive displays **Pagination workspace** without changing the active
  workspace; its table contains exactly 50 rows on page one and 13 on page two, and Previous works.
- CRC, SHA, compression, traversal and plaintext errors display the expected messages; Try again
  runs a fresh operation. A 120 MiB check was cancelled at **Verifying 4 of 8 files**, then a fresh
  check succeeded. The same manual cancellation worked in the production build.
- Escape during a check preserves the current composer draft and its selected 52-byte attachment.
  Browser Back during another active check switches workspace and closes the dialog; reopening
  there starts with no ZIP or stale report. No message was sent.
- QA covered dark/light themes and the 320×480, 390×844 and 1280×900 viewports. The short viewport keeps a
  214-pixel-high file scroller instead of collapsing it, and the page remains 320 pixels wide.
  A 560-pixel table scrolls inside its 260-pixel container so hashes and paths remain readable.
  The named region accepts keyboard focus and arrow-key scrolling; Tab/Shift-Tab stays in the
  dialog as controls change. Footer spacing and secondary-button colors were corrected after QA.
- Final server proof reports **0 provider invocations** and unchanged SHA-256 hashes for all seven
  original source files. Request logs contain only existing GET bootstrap/history/metadata calls
  and static asset reads; inspection adds no API request or mutation. Browser warning/error logs
  are empty.

The build emits Vite's size warning for the roughly 509 kB main chunk before gzip; the dedicated
Worker is about 107 kB. The test run also prints jsdom's unsupported document-navigation diagnostics
for link/download behavior; those do not fail the suite. These are recorded rather than presented
as browser failures or hidden by changing warning limits.

## Remaining ideas

A future restore workflow must validate state/transcript semantics and ownership, migrate supported
schemas, define duplicate workspace identities and handle missing credentials before writing data.
An inspection report is useful evidence for that workflow, but successful hashes alone cannot
authorize or establish a safe restoration. Compression support would also need its own bounded
decoder, compatibility fixtures and explicit expanded-byte policy.

Loading optional archive dialogs only when opened could reduce the initial JavaScript bundle. That
should preserve immediate cancellation, keyboard focus and workspace-switch guards while code is
loading, with acceptance tests for those transitions.
