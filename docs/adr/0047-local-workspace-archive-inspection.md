# ADR 0047 - Local workspace archive inspection

## Status

Accepted. Implementation and combined verification are recorded in the linked research report.

## Context

Workspace export produces a portable ZIP and a manifest of delivered-byte hashes. Reading the
manifest alone does not check that a saved or copied archive still contains those bytes. Users
need to inspect an archive independently of the currently selected workspace. An integrity check
does not establish that an archive is authentic, complete, semantically consistent or restorable.

## Decision

- Add **Inspect workspace ZIP** to Settings and `/inspect workspace zip` to the command palette.
  Opening the dialog and selecting a file do no work beyond local size checks. **Check ZIP** starts
  inspection. The archive remains in the browser; no upload endpoint or persistence is added.
- Run parsing, CRC-32 and SHA-256 verification in a dedicated module Worker. Pass the selected File
  through structured cloning, and return bounded progress, a report or a typed error. Keep the
  engine out of the main-thread execution path. Terminate the Worker on success, failure, cancel,
  dialog close or a 45-second deadline, including startup and stalled I/O. Ignore stale replies.
  Unsupported Worker or WebCrypto environments receive a visible error.
- Support Nexestra workspace export format 1, state version 7, in its stored, unencrypted,
  single-disk, non-ZIP64 ZIP profile. Recompressed archives and other compression/encryption
  profiles receive an unsupported-format error. No decompression or filesystem extraction occurs.
- Check ZIP end-of-directory bounds, central and local headers, names, sizes, CRC fields and data
  descriptors before hashing payloads. Reject unsafe or duplicate paths, hidden gaps, overlapping
  ranges, local/central disagreement, truncated records, directory/symlink entries and unsupported
  features. Every manifest-listed payload must occur exactly once, and every ZIP entry except
  `manifest.json` must be listed. Require the expected state/notice files and path/kind layout.
- Verify each payload's CRC-32 and SHA-256 against the ZIP metadata and manifest. Include NOTICE
  in the payload checks. Verify the manifest's ZIP CRC, parse its schema and exclusions, and keep
  its lack of a self-hash explicit. Success means that the declared payload hashes match the
  checked bytes; it is not an authenticity or restore-eligibility claim.
- Apply existing limits of 136 MiB per archive, 128 MiB of original payloads and 5,000 total ZIP
  entries. Bound the manifest and central directory to 8 MiB each and generated NOTICE to 64 KiB.
  The core checks cancellation and a 30-second deadline. Read one bounded stored entry at a time.
  WebCrypto's digest API requires the entire entry in memory; no new hashing dependency is added.
- Show the archive's own workspace name, export date, verified payload count, byte totals and a
  paginated file/hash list, with 50 entries per page. Keep the table scrollable by keyboard and allow
  horizontal scrolling on narrow screens. Render paths as text. Give failures a bounded
  explanation and a validated path where useful. Support cancellation, retry and choosing another
  ZIP. Keep focus inside the dialog when controls become disabled or disappear.
- Closing or changing workspace discards the inspection and releases the File/report. Within the
  current workspace, inspecting and closing preserves the route, composer draft and selected
  message attachments. An archive from a different workspace is inspectable without switching to
  or creating that workspace.

## Verification

See [research and QA record](../research/2026-09-09-local-workspace-archive-inspection.md) for
automated parser/lifecycle tests, real Worker behavior, archive variants and source-integrity checks.

## Limits

Inspection does not validate the deep semantics of state or transcript records, discover omitted
original data, authenticate the creator, scan malware or secrets, or prove that data can be imported.
It does not modify or redact the selected archive. Import, restore, migration, merge and file
extraction remain separate work.

Stored ZIPs produced by Nexestra are the supported profile. ZIP64, multiple disks, compression,
encryption, ZIP extra fields and self-extracting/container variants are unsupported. Streaming
entries must use zero local CRC/size fields and a matching 12- or 16-byte data descriptor. ZIP names
must be UTF-8 when flagged, ASCII otherwise, and contain no BOM. A ZIP repacked by another tool may
therefore fall outside this profile even if its payload bytes are unchanged. Per-entry digest buffering
and the bounded manifest/report consume memory proportional to their size; this is not constant-memory
inspection. Terminating a Worker discards its result, while browser-managed file/cache memory is
released according to the browser's lifetime rules. The selected archive and report are not saved
by the app, and the user must select the file again after closing the dialog.
