
# ADR 0031 - Thread rename and reversible archive

## Status

Accepted.

## Context

Threads are the canonical conversation records in Nexestra. Users need to rename a topic without losing its identity, and to put finished conversations away without deleting their transcript, artifacts, task links, or deep links. Slack-style archiving preserves history, stops new activity, and is reversible.

## Decision

- Thread gains an archived boolean with a Zod default of false, so existing state.json records and fixtures remain readable without a state-version migration.
- PATCH /api/threads/:id renames a thread using the same 1-80 name limits as creation. Renaming derives a unique slug from every thread in the workspace, including archived records, and never changes the thread ID, JSONL path, or artifact paths.
- POST /api/threads/:id/archive and POST /api/threads/:id/restore toggle the flag. Archiving updates updatedAt but keeps the transcript readable and exportable; linked tasks keep their process and read access.
- Archive is refused while the dispatcher has reserved writes or active runs for the thread, including queued, running, waiting-approval, waiting-input, manual delegation, auto-delegation, Worker assignment, and retry. A synchronous thread-write reservation re-reads the current thread and the archive mutation lock before incrementing, closing the window between an async snapshot and the durable enqueue. The store repeats the guard against persisted active runs and assignments as a second safety net.
- Archived threads reject new messages at the store layer before any transcript or artifact write, retries at the dispatcher, and manual delegations at the dispatcher.
- The normal thread list shows active threads only. A separate visible Archived list keeps existing deep links usable; an archived detail is read-only and offers Restore. Last-thread and workspace selection resolve against active threads only, with explicit archived deep links still honored. Drafts are stored per thread in localStorage and therefore survive archive and restore.
- Renaming, archiving, and restoring are record-level state changes, not transcript events.

## Consequences

- Deep links remain stable because IDs never change; slugs remain unique across the entire thread history of a workspace.
- Archiving preserves read/export and historical task process access, while retry, delegation, and new messages are blocked server-side without orphan writes.
- The UI cannot hide an in-flight send, retry, or delegation because archive checks the in-memory reservation before taking the archive lock.

## Known gaps

- There is no hard delete or bulk archive; restoring is the only way to reverse the flag.
- The archived timestamp is not stored separately yet; updatedAt reflects the archive moment.
- Drafts are browser-local, so they persist across archive/restore only on the same machine and browser.
- Renaming a thread changes its export file name but not its ID or deep link.
- Archive does not cancel task process access because archival is refused until tasks are idle; after archiving, historical task inspection, export, and review keep working while retry and delegation are blocked.
