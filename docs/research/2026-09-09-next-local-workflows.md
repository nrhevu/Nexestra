# Research: next local workspace workflows

Research date: 9 September 2026 (Asia/Ho_Chi_Minh). These were candidates identified during the
transcript-search and document-preview wave. Branch selection is now implemented;
its status and verification are recorded in the [branch selection report](2026-09-09-repository-branch-selection.md).
Portable workspace export and recoverable message submission remain research only.

## Explicit repository branch selection

The repository contract records `defaultBranch`, `sourceCommit` and `sourceRef`. Source refresh
fetches that recorded branch. ADR 0033 deliberately leaves a deleted or renamed branch as a visible
error instead of guessing a replacement. At that point there was no control for choosing another
branch for future Worker assignments.

[Git's clone documentation](https://git-scm.com/docs/git-clone) describes selecting a branch with
`--branch` and the narrower history/ref behavior of `--single-branch`. These options establish that
branch choice is distinct from refreshing a commit; they do not prescribe Nexestra's UI or lifecycle.
The research subagent fetched and read the official page and checked the current implementation.

A useful next slice would explicitly choose an existing source branch, fetch it into a private ref,
and publish the selected commit only after a successful fetch. Existing Worker worktrees must keep
their original commits and edits. A stale dialog must not overwrite a newer branch choice. Tests
should use local Git fixtures with two branches, a deleted branch, failed fetches and an existing
assignment. Branch names require Git ref validation and safe argument handling, including names
that resemble command flags. This is a proposed extension of source refresh, not an automatic
branch switch or a merge/push workflow.

## Portable workspace export

Nexestra currently exports individual threads as Markdown. It does not export a workspace's
structured metadata, canonical transcripts, document history and attachments as one artifact.
A portable export could include a manifest of relative paths, byte counts and SHA-256 hashes while
excluding the credential store and external harness state.

[JSON Lines documentation](https://jsonlines.org/) provides the format requirements for structured
log files. [Git bundle documentation](https://git-scm.com/docs/git-bundle) describes portable Git
objects and refs. The research subagent fetched and read both. These sources describe formats;
choosing a workspace archive and its inclusion rules is a Nexestra design proposal.

Export is a larger decision than copying a data directory. It needs a coherent snapshot while
messages, revisions and assignments can change; strict workspace scope; bounded I/O; and explicit
handling of sensitive text in old transcripts and uploads. Repository clones, assignment worktrees
and uncommitted edits are outside the initial proposal. Browser drafts would also be absent.
Without import/restore and verification, such an export must not be presented as a complete backup.

## Recoverable message submission

The conversation-history work exposed another concrete boundary: `appendMessage` durably appends
JSONL before writing the thread counters to `state.json`. A metadata-write failure or a lost HTTP
response can leave a saved message while the browser sees failure. `createUserMessage` assigns a
fresh UUID for each call, so submitting the same intent again can save another message.

[RFC 9110 section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2) explains why a
client needs known idempotent semantics, or proof that the first attempt was not applied, before
automatically retrying a non-idempotent request. The POST method alone does not provide that
guarantee. [Stripe's idempotency documentation](https://docs.stripe.com/api/idempotent_requests)
illustrates a client-generated random request key and rejecting reuse with different parameters.
Its response caching and retention choices are specific to that API; they are not requirements
for Nexestra. Both official sources were fetched directly over HTTPS and read on 9 September 2026.

A candidate Nexestra design would preserve a random request ID for the same pending browser send,
record that identity with the canonical message, and rebuild its lookup after restart. A repeated
key with the same payload should resolve the saved result; changed content or attachments should
be rejected explicitly. Separate intentional messages with identical text need separate keys.

This requires defining dispatch recovery, attachment identity and the effect of failures between
persistence and dispatch. Recovery must inspect durable run records, including a queued run whose
append succeeded before a later operation failed; a check of in-memory runs alone is insufficient.
Uploads written before a crash can become unreferenced files under the current random IDs. If the
follow-up adopts deterministic attachment IDs, reusing an existing file requires verifying its
bytes rather than treating every existing filename as success. A request key alone cannot guarantee
exactly-once effects inside an external harness. Acceptance should cover lost responses, concurrent
duplicate requests, changed payloads, uploaded-file reuse, server restart and a deliberately repeated
identical message. Browser reload cannot restore a JavaScript `File` object from a text-only draft.
This remains a proposed follow-up, separate from the history index and paging implementation.

## Priority

Branch selection was prioritized because source refresh already defines how future assignments
obtain a commit without altering existing work. Keep workspace export in research until its
snapshot and restoration boundaries are concrete. Recoverable submission is the next correctness
candidate because the history tests now demonstrate the durable-append/failed-metadata boundary.
The search/preview verification report does not cover these follow-ups; branch selection has its
own report linked above, and recoverable submission has not been implemented or verified yet.
