# Portable workspace export — research and QA, 9 September 2026

## Why this idea

Run history made past work easier to find. The next missing local workflow was moving its data
out of Nexestra: a workspace has structured metadata, canonical conversations, original uploads
and retained document versions, while the existing export only produced thread Markdown.

The proposal is an explicit workspace ZIP with an inclusion manifest and delivered-byte SHA-256
hashes. It preserves selected-workspace data without copying the whole storage directory. The
snapshot, credential handling and exclusions are Nexestra design decisions; the source documents
below establish format and API behavior rather than prescribing this feature.

## Primary sources

- [JSON Lines](https://jsonlines.org/) describes UTF-8, one JSON value per line and line terminators.
  Nexestra retains JSONL event structure, then re-serializes records after known-credential
  redaction. This keeps structured events available for external inspection.
- [fflate's official README](https://github.com/101arrowz/fflate#readme) documents incremental ZIP
  generation using `Zip` and `ZipPassThrough`. This supports a stream-to-file implementation with
  stored entries. Version 0.8.3 is pinned; no vendor performance claim is used as evidence here.
- [Node.js file streams](https://nodejs.org/api/fs.html#filehandlecreatereadstreamoptions) document
  bounded read chunks, cancellation signals and file-descriptor closure. The
  [temporary-directory API](https://nodejs.org/api/fs.html#fspromisesmkdtempprefix-options) provides
  unique temporary paths. These primitives support the implementation; coherent snapshot checks,
  safe path ownership and cleanup remain application responsibilities.

The web tool returned a transport 404. These official pages were fetched directly over HTTPS and
read on 9 September 2026. The package version was verified through the configured package registry.

## Implementation scope

Three subagents implemented independent slices: streaming ZIP/manifest generation, FileStore/API
snapshot and download lifecycle, and an accessible export dialog. Root handled Settings/command integration,
acceptance tests, review, documentation and native QA. The fixed contract is
[ADR 0046](../adr/0046-portable-workspace-export.md).

Included data: selected workspace metadata, agents, tasks and assignments; active and archived
canonical transcripts; referenced uploads; retained document revisions and legacy documents.
Repository and external-reference metadata remain, but their files are excluded. Credential stores,
harness auth, browser drafts/selected files, and unreferenced local files are excluded. No restore
or import workflow is implemented.

## Verification record

The final combined `pnpm check` passed: lint checked 117 files, TypeScript passed, all **736 tests
in 52 files** passed, and both production builds completed. This adds 75 tests to the preceding
661-test baseline. The command ran on the installed Node 26 runtime with
`NODE_OPTIONS=--no-experimental-webstorage`, consistent with the preceding verification waves.
Default tests used fake providers and required no credentials or installed harnesses.

Native browser QA used an isolated, two-workspace FileStore and a fake runner. Settings and the
command palette opened the export dialog without a download request. Explicit Download ZIP
returned HTTP 200 and reached the success state for each selected workspace. Injected conflict,
Retry and Cancel worked; Browser Back into another workspace aborted the pending HTTP request
and dismissed the dialog. Opening, closing and switching workspaces preserved the composer draft
and its selected 44-byte file. No provider was invoked and no browser warning/error was observed.

The dark dialog at 320 × 480 and light dialog at 390 × 844 stayed inside the viewport. The narrow
busy footer wrapped both controls without horizontal overflow. The in-app browser's download-event
wait timed out for the Blob handoff, so native disk-save completion is not claimed. The UI success
state, server response and archive bytes were checked separately.

The first archive was fetched through the actual HTTP endpoint and read using system `unzip -t`
and Python's independent `zipfile` implementation. All 31 assertions passed: nine unique relative
entries, CRC, manifest coverage, SHA-256 and byte counts; exact selected metadata including archived
records; canonical events and submission receipts after known-key redaction; unknown 12 KiB JSON
fields and an unclipped run error; exact binary upload and two document revision payloads; and the
specified credential, foreign-workspace, repository, local-reference and orphan-file exclusions.
Seven original state/transcript/upload/document hashes remained unchanged. A separate six-entry
archive verified the second workspace's isolation, CRC and payload hashes.

An independent boundary suite reproduced a source-change error being incorrectly mapped to
`invalid` by the archive layer. The regression exercises the complete export pipeline after an
early source has streamed, rather than testing the snapshot iterator alone. It also exercises
deadline/abort settlement behind a blocked write queue, ownership of a newer export reservation,
and invalid UTF-8, torn and oversized transcript lines. The fixed implementation checks binary
file-descriptor identity before and after reads; regressions replace an inode after path validation
and alter a file after its first chunk. Binary credential scanners are created per file, with
coverage for a key spanning chunks within one file and harmless fragments in separate files.

Running the three server export suites together exposed an archive cleanup assertion that inspected
all exports in the operating-system temp directory and therefore observed concurrent suites' files.
The archive tests now use a private temp root per test, while retaining the cleanup assertions.

The UI regression suite also reproduced Tab leaving the dialog when its focused primary action
became disabled. Focus containment now uses the current enabled-control list, with Tab and
Shift+Tab coverage in busy and success phases. A type import discovered during combined checking
was corrected to reference its declaring module. No private export temp directories remained
after the fixture downloads and test cleanup.

The full run also exposed an existing attention-screen test firing its manually controlled timer
before the effect registered it. That test now waits for the timer registration and rendered task
action before interaction; its workspace-switch assertions remain unchanged.

## Remaining ideas

A separate importer would need schema migration, archive/path validation, conflict handling,
credential reconfiguration and explicit workspace-identity rules before this artifact could be
called restorable. It should begin with a read-only validation report, not direct writes into the
current data directory. A general secret scanner also needs its own false-positive and supported
encoding policy; this export deliberately promises only known-credential handling.
