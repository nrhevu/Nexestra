# ADR 0046 - Portable workspace export

## Status

Accepted; combined verification is recorded in the linked research report.

## Context

Thread Markdown export is useful for reading a conversation elsewhere, but it omits the structured
workspace, retained document versions and original uploaded files. Copying the data directory also
copies unrelated workspaces, provider credentials, repository clones and temporary files, and can
mix metadata with transcripts written at different times.

## Decision

- Add an explicit `GET /api/workspaces/:id/export` that prepares a complete ZIP before returning
  download headers. There are no query options or raw-secret mode. Unknown workspaces return 404;
  invalid source data and exceeded limits fail visibly, and conflicting exports or source changes
  return 409. Export does not dispatch agents or alter the canonical data.
- Export a state version 7 projection containing exactly the selected workspace and its agents,
  active and archived threads, tasks, Knowledge metadata and Worker assignments. Include each
  canonical JSONL transcript, uploads referenced by those transcripts, and all retained document
  revision bytes. Legacy documents keep their original managed document file. Derive owned paths
  from validated IDs and metadata rather than walking the data directory.
- Keep repository and local-reference metadata, but exclude repository files, assignment worktrees,
  credential and harness-auth files, browser state and unreferenced files. Deleted document bytes
  cannot be recovered by export. This is a portable data artifact; importing or restoring it is not
  supported and it is not a complete application backup.
- Re-serialize each JSONL record with recursive known-credential redaction, including unknown
  fields and keys, preserving full event payloads, sequence numbers and submission receipts.
  Do not reuse presentation projections that clip tool output or error text. Export original
  upload/document bytes exactly; if a literal known credential is found in those bytes, reject
  the export instead of changing the file. Credential detection is not a general secret scanner
  and does not decode arbitrary binary encodings.
  Freeze the credential set with the snapshot, so rotating or removing a key during generation
  cannot expose its old value. Apply the same redaction to manifest workspace labels.
- Reserve one export per FileStore through preparation and download. Under the existing write
  serialization, capture the selected state and source file identities and enumerate referenced
  uploads from bounded JSONL reads. Release the write barrier before archive generation. Reject
  symlink components, non-regular sources, unsafe or foreign paths, malformed records, missing
  referenced bytes and document hash/size mismatches. An empty thread with no transcript exports
  an empty JSONL; a known nonempty missing transcript is an error.
- Revalidate source identities before and after reads and before handing off the complete archive.
  If included files change, fail without sending a partial ZIP. This provides an application
  snapshot in one server process, not a filesystem transaction against arbitrary external writers.
- Use the pinned `fflate` 0.8.3 streaming ZIP API with stored entries and SHA-256 per delivered
  payload. Spool to a private temporary directory and file rather than retaining the workspace
  or ZIP in memory. Relative archive paths are unique and validated. `NOTICE.txt` states scope and
  limitations; `manifest.json` identifies format version 1, redaction mode, workspace, exclusions,
  byte counts and hashes. The manifest covers payload files including NOTICE, not itself.
- Bound preparation to 128 MiB source data, 136 MiB output, 5,000 entries and 30 seconds, including
  waiting for the write barrier. Propagate caller cancellation and clean up on failure. Stream
  the completed file with no-store headers; release the reservation and temporary file on finish,
  cancel, error or the bounded download lifetime.
  The entry limit includes both generated files. Archive failure cleanup has a 100 ms grace period;
  an operating-system close or removal that remains pending continues with observed cleanup in the
  background. Late temp-directory and file-open completions retain their cleanup owner.
- Add Settings → Export selected workspace and `/export workspace`. Opening the dialog is inert;
  Download ZIP starts one request. Cancel and Retry are explicit. The browser verifies ZIP MIME
  and size, retains at most one completed Blob, uses a 45-second deadline, and releases its object
  URL after the download capture window. Workspace switch or dialog close aborts and discards late
  work. Opening or closing export preserves the route, composer drafts and selected files.
  Keyboard focus remains inside the dialog when its primary action becomes disabled.

## Verification

See [research and QA record](../research/2026-09-09-workspace-export.md) for the observed automated
checks, native browser behavior, independent extraction and source-integrity evidence.

## Limits

Snapshot preparation scans included transcripts while holding the store write barrier, so writes
may wait for bounded inventory I/O. JSONL is read again during generation. Stored ZIP entries avoid
compression work but produce larger downloads. Source inventory and the manifest grow with the
bounded entry count; metadata is buffered within the source budget, while binary data is streamed.
The browser buffers a bounded ZIP Blob before starting the download.

The known-credential set can only cover values already known to this FileStore. Arbitrary prose,
uploads and documents can contain other sensitive information. Literal binary detection does not
decode compressed or encoded secrets. Redaction changes transcript bytes; hashes describe the
delivered archive contents and are integrity checks, not digital signatures or authenticity proof.

There is no import, merge, automatic schedule, progress percentage, compression option, export
history or multi-process coordination. A process crash may leave a private ZIP in operating-system
temporary storage; startup does not sweep unrelated temporary directories. Browser downloads are
owned by the user after handoff, and the app cannot verify whether the browser saved them to disk.
