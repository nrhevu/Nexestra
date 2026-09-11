# Research: repository recovery and assignment review

Research date: 8 September 2026 (Asia/Ho_Chi_Minh).

## Evidence and product choices

[Git clone](https://git-scm.com/docs/git-clone) permits an existing destination only when it is
empty. A retry that blindly reuses or removes a failed destination can either fail repeatedly or
discard files that were added after the first attempt. Nexestra's failed Knowledge record already
has the identity and source needed for another explicit attempt. The selected design is to retain
that record, clone into a private staging location, and publish only when the destination is safe.
This is a local design inference from Git's behavior, not a Git-provided recovery transaction.

[Git worktree](https://git-scm.com/docs/git-worktree) describes linked worktrees sharing repository
objects and refs while retaining their own HEAD and index. A review therefore needs the assignment's
recorded starting commit; the managed clone's later HEAD is not a reliable substitute. New Worker
assignments should record that commit before invocation, while older assignments without a recorded
base should say that the comparison is unavailable.

[Git diff](https://git-scm.com/docs/git-diff) supports comparing a commit with the working tree and
provides `--no-ext-diff` and `--no-textconv`. The review must disable external diff and conversion
programs and bound its output. [Git status](https://git-scm.com/docs/git-status) documents stable
porcelain output, NUL-separated paths, untracked files, and the optional filesystem monitor hook.
Those details inform separate tracked-change and untracked-file displays, robust filename parsing,
and disabling hooks during inspection. A tracked diff alone cannot establish that a worktree is
clean or that cleanup will succeed.

A local Git fixture additionally confirmed that `--no-ext-diff --no-textconv` does not prevent a
configured clean filter from executing when Git compares a tracked worktree file. The implementation
must handle clean/process filters explicitly. This finding came from an isolated temporary repository
whose filter wrote a marker file; no user repository or live provider was involved.

[Git fetch](https://git-scm.com/docs/git-fetch) updates fetched objects and remote-tracking refs.
An explicit refresh for future assignments remains a separate design task: it must define which
commit future assignments use while preserving existing assignment branches and recorded bases.
It is not part of Retry clone.

The web search tool returned an error in this pass. The linked official pages were instead fetched
directly over HTTPS and read locally. No live provider, external repository credential, benchmark,
or usability study was used to choose these changes.

## Acceptance criteria

| Gap | Selected behavior | Required evidence |
| --- | --- | --- |
| A failed clone requires deleting and recreating Knowledge. | Retry explicitly from its existing detail view, retaining its identity and source, with bounded Git execution and visible errors. | Local Git retry/failure/concurrency tests, preservation of unexpected destination contents, API and UI checks. |
| The process view exposes cleanup before a user can inspect the Worker's changes in the app. | Record a stable starting commit and load a read-only comparison on demand, with a separate untracked list. | Committed and dirty changes, stable base after main advances, path containment, external-driver guards, output caps, redaction, and UI checks. |

No merge, push, reset, automatic cleanup, or background repository synchronization is selected in
this wave. The inspection is a bounded view of local files, not proof that the task meets its
acceptance criteria; the existing verification command remains the task's completion check.

## Next candidates

1. Explicit source refresh for future assignments, with a defined starting-ref policy.
2. Thread rename/archive behavior that keeps canonical transcripts and active work discoverable.
3. Stored-document revisions that retain Knowledge identity and provenance.

## Verification checkpoints

The integrated branch passed `pnpm check`: lint, typecheck, 261 tests across 22 files, and production
builds. Node 26 needed the command-local `NODE_OPTIONS=--no-experimental-webstorage` flag for jsdom;
no project or global runtime setting was changed. Tests use temporary local Git repositories and
fake runners, with no live providers or credentials.

The shared numstat parser has six passing tests with stored protocol fixtures, including binary
counts, filenames containing tabs/newlines, malformed records, bounded file lists, and incomplete
output. Recovery tests cover identity, concurrency, destination preservation, provenance, failed
state writes, and startup rollback. Review tests cover the captured base, safe paths and Git
configuration, redaction, output limits, and stale UI results. A UI regression test ensures files
after the tenth entry remain accessible; all server-bounded rows now appear in scrollable lists.

An in-app browser check against the integrated server and SPA exercised this sequence:

1. Retry a failed clone while its local source is still absent; retain the visible failure and
   enabled retry action.
2. Make the local source available and retry again; retain the Knowledge identity and creation
   time, change the card and open details to `ready`, and keep that state after a page reload.
3. Select the recovered repository immediately when delegating a task to a fake Worker. The
   Worker creates a real isolated worktree, commits one file, modifies another, and leaves an
   untracked file.
4. Open Git review and verify the recorded base and HEAD, committed/staged/dirty/base-to-worktree
   summaries, untracked list, and unified patch. An explicit Refresh includes a subsequent local
   edit. The expanded patch was also inspected visually in the process dialog.

The implementation decisions and remaining limits are recorded in
[ADR 0029](../adr/0029-repository-clone-retry.md) and
[ADR 0030](../adr/0030-read-only-assignment-git-review.md). Review remains a non-atomic bounded
snapshot; legacy assignments have no guessed base, custom Git filters disable review, and nested
submodule contents are excluded. Interrupted clone staging directories are retained because their
ownership is not yet journaled. A persistent state-write outage can require restart recovery.
