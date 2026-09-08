# Research: next local workspace workflows

Research date: 9 September 2026 (Asia/Ho_Chi_Minh). These were candidates identified during the
transcript-search and document-preview wave. Branch selection is now implemented;
its status and verification are recorded in the [branch selection report](2026-09-09-repository-branch-selection.md).
Portable workspace export remains research only.

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

## Priority

Branch selection was prioritized because source refresh already defines how future assignments
obtain a commit without altering existing work. Keep workspace export in research until its
snapshot and restoration boundaries are concrete. The search/preview verification report does not
cover either candidate; branch selection has its own report linked above.
