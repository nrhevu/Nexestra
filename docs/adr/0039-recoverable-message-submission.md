# ADR 0039 - Recoverable message submission

## Status

Accepted for Milestone M9.

## Context

A user message is appended and synced to canonical JSONL before thread metadata is written and
before the HTTP response reaches the browser. A metadata-write error or a lost success response
can leave a saved message while the composer still displays its draft. The previous send path
assigned a fresh message UUID to each retry and enqueued another set of mentioned agents.

The history tests already demonstrate a durable message after a metadata-write failure. A local
HTTP fault-injection fixture now reproduces the client-visible case: fail the success response
after persistence, repeat the same send, and observe two distinct saved messages.

## Decision

- Give each browser send intent an opaque random UUID `requestId`, accepted in JSON and multipart
  requests. Reusing it for the same pending payload confirms the saved message; a new intentional
  send gets a new ID even when its text is identical. Legacy requests without a key retain their
  existing semantics. New creation returns 201; confirmed replay returns 200 with `replayed: true`
  and current durable runs. Responses are not cached verbatim.
- Scope deduplication to a thread and request identity. Compute a server-owned fingerprint from
  trimmed content and the ordered, normalized upload metadata and byte digests. A reused identity
  with a different payload is a conflict. Never accept a client-supplied content hash as proof.
- Record a private submission receipt in the canonical `message.created` envelope. Keep its
  identity/fingerprint out of public messages, history responses and Markdown exports. Rebuild
  receipt lookup from JSONL on startup and extend it after durable appends. No second transcript,
  durable response cache or independent submission journal is introduced.
- Serialize duplicate submissions through the store's write barrier and through dispatch
  coordination. Preserve the saved message's mentions, Knowledge revision pins and artifact
  identities on replay; do not reinterpret its text using renamed agents or changed Knowledge.
- Reconcile each original mention against durable run records. Return existing runs, including
  completed or failed runs and their latest retry attempts. Only a missing initial run is eligible
  for dispatch. A request receipt alone cannot justify rerunning a process with uncertain effects.
  A durable queued record with no live queue entry is reconciled using the same run ID. Startup
  recovery still marks ambiguous interrupted execution explicitly. Unavailable original agents
  receive a failed run or a failed update of that queued run; archived confirmation dispatches
  nothing. Agent mutation reservations stay held until a failed update has finished persisting.
- Keep pending browser identities in App-owned state scoped by workspace and thread, with guarded
  browser persistence. An acknowledgement only retires the intent and draft revision it sent.
  Persist descriptors and fingerprints, not uploaded file bytes. Reload cannot restore a browser
  `File`; attachment recovery must require the original files or an explicit new send intent.
- Keep explicit run retries and the dispatcher's existing retry policy separate from submission
  confirmation. Submission deduplication does not promise exactly-once external harness effects.

## Receipt and recovery format

The private `submission` object contains `requestIdHash`, `fingerprint` and a frozen `artifactPlan`
of at most 40 descriptors. Both hashes use SHA-256. The payload hash covers a versioned JSON object
containing trimmed content and an ordered array of normalized file name, normalized/inferred media
type, size and byte hash. The raw request UUID and upload bytes do not enter the receipt. Public
`Message` parsing strips this private envelope from responses, history, search and Markdown export.

Upload IDs are deterministic for the thread, request identity, input position and byte hash.
Existing keyed files are reused only after their bytes match. If the message survived but some
artifact frames did not, replay appends only the missing frozen descriptors with new monotonically
increasing sequences. Missing bytes in that partial transaction can be restored from the matched
retry payload. A complete receipt whose upload was removed or changed returns a visible conflict;
it is not silently treated as complete. Legacy receipts without an artifact plan cannot repair
missing frames. Archived threads require Restore before an artifact repair.

After an ambiguous append/sync failure, the error path repairs only an incomplete tail and rebuilds
receipt offsets and sequence state from canonical JSONL. Visible bytes must successfully sync
before a replay can return a message for dispatch. Persistent sync failure retains the unresolved
receipt and returns an error. Dirty thread metadata is flushed by either replay entry point.

A receipt miss must also verify the index and transcript identity before it can permit a new send.
Unexpected missing, appeared or changed files and malformed receipt state fail with 409. Conflicting
receipts for different message IDs or offsets cannot silently select a winner; the transcript is
marked unreliable. Re-priming the exact same receipt is allowed.

## Required failure boundaries

- A durable append followed by failed metadata persistence must remain discoverable by its key,
  with correct subsequent sequences and recoverable thread counters.
- Concurrent requests with the same key and payload must save one message and enqueue one initial
  run per original mention. Concurrent reuse with a different payload must fail as a conflict.
- Partial dispatch of multiple mentions must not repeat agents that already have durable runs.
- A confirmed saved message must remain confirmable after a thread is archived or an agent is
  changed. Confirmation must not turn these changes into fresh provider calls.
- Uploaded files left before a transcript append must not create duplicate copies on recovery.
  Reusing deterministic paths requires verifying file bytes. Incomplete durable message/artifact
  transactions must be repaired consistently or rejected visibly; they must not be treated as a
  successful complete replay or silently duplicated.

## Verification

The integrated `pnpm check` passes: 514 tests in 38 files, lint, TypeScript and production build.
New focused coverage consists of 31 store tests, 17 dispatch/API tests, 18 browser submission tests
and two deferred-digest timing tests. It covers lost responses, metadata failures, concurrent
duplicates, changed content and uploads, upload order, restart, attachment recovery, partial
dispatch, explicit run retries, browser navigation/reload, denied browser storage, and stale send
acknowledgements. Async UI assertions wait for bootstrap completion and scheduled message focus.

Local HTTP fault injection and native browser checks confirm the same message and run identities
after a lost response, navigation, reload and server restart. The fresh-thread upload case runs
without a preceding history read. Every provider-facing check uses a fake runner. See the
[research and verification record](../research/2026-09-09-recoverable-message-submission.md).

## Known limits

- Legacy unkeyed API calls cannot receive the keyed-send guarantee.
- Receipt lookup grows with retained submissions and must be rebuilt after restart.
- Browser storage can be unavailable or removed. File objects cannot survive reload without the
  user supplying the files again; descriptor persistence is not file persistence.
- Explicit and automatic run retries can invoke a harness again. Crash recovery must report
  ambiguous execution rather than infer that an external side effect never occurred.
- This change is not a transaction protocol across multiple server processes or machines.
