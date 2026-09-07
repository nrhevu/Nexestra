# ADR 0019: General work execution and captured deliverables

Status: Accepted. Date: 2026-09-07. Extends ADRs 0013, 0015 and 0018.

## Context

Research, documents and design should not need a Git repository. The old manual Taskboard route
also bypassed the normal Worker queue and omitted durable trigger/run records. A file left in a
mutable working directory is insufficient to identify the output a human reviewed.

## Decision

Manual starts and Master delegation share one execution path, queue, run transcript, activity,
stop handling and completion lifecycle. A Taskboard start saves an explicit user @mention before
any invocation, compares the task revision, persists a queued assignment/run and returns HTTP 202.
One Worker runs serially; each task admits one active attempt atomically. Final assignment state
cannot be overwritten. State write failures do not publish an assignment in the in-memory view.

Every new assignment requires behavioral criteria. Code tasks use a ready repository worktree.
Other work types may omit the repository and receive a fresh managed directory with TASK.md and
outputs/. Codex and OpenCode receive the matching general-purpose instructions. Both kinds remain
in the existing single process/local-file architecture. Directory isolation is not an OS sandbox.

After a non-Git run, the host captures outputs/ as generated artifacts attached to the Worker's
canonical reply. It accepts at most 10 files, 20 MiB per file and 50 MiB total, bounded directory
traversal, and rejects symbolic links, hard links, nonregular files and known stored credentials.
Captured bytes receive a SHA-256 digest. Active HTML is served as an attachment, never trusted app
markup. The assignment records its result message and output manifest. Human acceptance records
that manifest and checks that the captured bytes still match it. Edits to the working directory
do not modify captured artifacts. A run that cannot capture its outputs fails visibly.

The Master can use read_tasks in a fresh tool session to discover eligible existing tasks without
adding them to its pending-plan loop. Prior human review notes are supplied on a new attempt.
Reading a task does not invoke a Worker. App-native tools still belong to custom-provider Masters;
Codex OAuth Masters do not yet have that tool bridge.

## Verification

Offline tests exercise HTTP start → persisted mention → isolated directory → Worker → captured
artifact → download → review → restart, without Git or provider credentials. Further scenarios
cover duplicate admission, queued cancellation, Worker failures and retries, stale starts, modified
snapshots, capture limits and link rejection. CLI prompt tests cover Codex and OpenCode. Browser QA
runs the full document path with an explicitly labeled offline Worker fixture.

## Limits

Human evidence remains a human judgment; executable independent verifiers are future work.
Repository assignments retain branches/worktrees but do not yet automatically snapshot Git diffs
or commits into a verifier manifest. Capturing outputs is not protection from a malicious process
with the OS user's full authority; stronger execution and evaluator isolation remain separate work.
Failed runs retain their working directory; cleanup and retention controls are not yet available.
