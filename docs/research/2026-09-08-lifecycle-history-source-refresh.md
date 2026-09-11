# Research: thread lifecycle, document history, and source refresh

Research date: 8 September 2026 (Asia/Ho_Chi_Minh). Integrated verification: 9 September 2026.

## Evidence and selected ideas

[Slack's archive documentation](https://slack.com/help/articles/213185307-Archive-or-delete-a-channel)
describes archiving as closing new activity while retaining history, with a reversible unarchive
action. Before this wave, Nexestra had stable thread IDs and canonical transcripts but no rename/archive
flow. The selected local design preserves those identities, offers an archived list and restore,
and refuses archival while live or reserved work could be hidden. Applying this to single-user
threads is our product decision, not a claim that Slack defines Nexestra's behavior.

[Notion's version history documentation](https://www.notion.com/help/duplicate-delete-and-restore-content)
supports inspecting and restoring earlier content versions. Nexestra's Knowledge metadata already
had a durable identity, but uploaded bytes required delete-and-create to replace. The selected design
adds immutable document revisions, replacement and restore without changing `#handle` identity.
New messages must pin the document revision they reference so queued runs and retries cannot receive
different source bytes after an edit. Historical references without revision provenance cannot be
retroactively assigned a version by rewriting the transcript.

[Git fetch](https://git-scm.com/docs/git-fetch) separates fetching refs from updating a checkout and
documents explicit ref mappings, atomic ref updates, and controls for pruning, submodules and
maintenance. The selected design fetches one recorded branch to a new private ref, then publishes
the resolved commit for future Worker preparations. Existing Worker branches and the managed clone's
checkout remain intact. A failed refresh retains the previous selection.

Web search returned an HTTP 404 tool error. These official pages were fetched directly over HTTPS
and read locally instead. The initially guessed Notion `/help/version-history` page also returned
404; the linked content page above was fetched successfully and contains the version-history
section. No paid service, live provider, external credentials, or usage study was used.

## Acceptance criteria

| Idea | User-visible result | Required evidence |
| --- | --- | --- |
| Thread lifecycle | Rename, archive, find archived threads, restore, and retain drafts and links. | Stable transcript/ID, server-side activity and archived-write guards, send/delegate races, UI navigation and drafts. |
| Knowledge revisions | Replace document bytes, inspect/download history, restore a past version. | Immutable old bytes, pinned new references, optimistic conflicts, legacy fallback, state-write rollback, UI error and stale-result guards. |
| Repository source refresh | Fetch the latest recorded default branch explicitly for future assignments. | Existing clone and Worker edits unchanged, new base used, failures retain ready state, safe refs/hooks, persistence, API and UI checks. |

## Verification checkpoints

The source-refresh slice passed `pnpm check` with 275 tests across 24 files, lint, typecheck, and
production builds. Its nine new local-Git/API tests cover selection and preservation, failures,
restart and rollback, locks, hooks, containment, and redaction. Five UI tests cover success, failure,
closed details, switching away and back, and no automatic refresh while idle.

An in-app browser check on commit `4a29fe6` advanced a temporary local upstream after cloning,
clicked **Refresh source**, and verified the selected full SHA in Knowledge. Delegating a fake
Worker then recorded that SHA as its Git review base. Renaming the upstream branch made the next
refresh fail visibly while retaining `ready` and the prior commit; restoring the branch and
refreshing again cleared the error. The Knowledge detail layout was inspected visually.

Thread lifecycle and document history are integrated in commits `c4b340b` and `bd76a00`. The first
combined gate passed 303 tests across 26 files, lint, typecheck, and production builds. An additional
HTTP acceptance test then confirmed that both current and historical downloads refuse a revision
whose bytes no longer match its recorded checksum.

An in-app browser check used a temporary local store and fake Worker on 9 September:

- Renaming, archiving, reloading an archived deep link and restoring retained the original thread ID,
  export link, seed message and unsent draft. The canonical JSONL file's SHA-256 remained
  `220d276a307f91a741d6e717d98ce8f54bd2efd1276abf63f813f588bcec005f` through those metadata changes.
- With every thread archived, returning from Knowledge to Threads displayed the Archived list and
  the create-thread empty state. Restoring a thread made its composer and draft available again.
- Restoring document v1 from a two-version history produced a third revision and kept the original
  download links. A subsequent `@maya summarize #release-guide` message pinned the restored revision
  in the canonical JSONL, and the fake Worker received v1's Friday instructions. The ordinary
  Knowledge card also displayed the restored filename.
- **Refresh source** remained functional after the UI integration and displayed the full selected
  SHA. Its upstream advancement, failure recovery and Worker base selection were checked in the
  earlier source-refresh browser pass described above.

The browser pass covered history/restore and visual layout. Native file-picker upload was covered
by the six UI tests using actual `File`/`FormData` uploads, rather than claimed as a browser action.
Browser review also prompted separating the bounded history list from the replacement form, so the
form no longer scrolls inside the history area. The layout was rechecked visually after that change;
the named history region contains only revision actions, while the replacement input, error and
button remain outside it.

The final code, committed as `504bd89`, passed `pnpm check` with **304 tests across 26 files**, Biome
lint, TypeScript and both production builds on 9 September. The temporary browser/backend/frontend
QA sessions were closed afterward.
Tests use the command-local Node 26 flag `NODE_OPTIONS=--no-experimental-webstorage` for jsdom and call
no live providers.

## Further candidates

1. Search across archived and active transcript content without a second canonical message store;
   [research and the delegated next slice](2026-09-09-transcript-search.md) are now underway.
2. Preview textual Knowledge content and revisions with bounded, safe rendering.
3. Select a source branch explicitly when a repository's upstream default branch changes.
4. Export a workspace's metadata and canonical logs as a portable local backup with a defined
   credential boundary and restore validation.
