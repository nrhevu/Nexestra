# Research: thread lifecycle, document history, and source refresh

Research date: 8 September 2026 (Asia/Ho_Chi_Minh).

## Evidence and selected ideas

[Slack's archive documentation](https://slack.com/help/articles/213185307-Archive-or-delete-a-channel)
describes archiving as closing new activity while retaining history, with a reversible unarchive
action. Nexestra currently has stable thread IDs and canonical transcripts but no rename/archive
flow. The selected local design preserves those identities, offers an archived list and restore,
and refuses archival while live or reserved work could be hidden. Applying this to single-user
threads is our product decision, not a claim that Slack defines Nexestra's behavior.

[Notion's version history documentation](https://www.notion.com/help/duplicate-delete-and-restore-content)
supports inspecting and restoring earlier content versions. Nexestra's Knowledge metadata already
has a durable identity, but uploaded bytes require delete-and-create to replace. The selected design
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

Thread lifecycle and document history implementation are still in progress. Final integration and
browser evidence will be recorded here before handoff. Tests use the command-local Node 26 flag
`NODE_OPTIONS=--no-experimental-webstorage` for jsdom and call no live providers.

## Further candidates

1. Search across archived and active transcript content without a second canonical message store.
2. Preview textual Knowledge content and revisions with bounded, safe rendering.
3. Select a source branch explicitly when a repository's upstream default branch changes.
4. Export a workspace's metadata and canonical logs as a portable local backup with a defined
   credential boundary and restore validation.
