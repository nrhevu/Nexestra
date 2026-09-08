# Research: choosing the source branch for future Workers

Research date: 9 September 2026 (Asia/Ho_Chi_Minh).

## Observed gap and selected direction

Source refresh records a new commit from the repository's original default branch. A repository
with work on another branch cannot currently select that branch for future Worker assignments.
The selected change is an explicit source-branch picker that publishes a fetched commit only after
success. Existing Worker worktrees keep their original commits, index and working files.

## Primary-source evidence

[Git's ls-remote documentation](https://git-scm.com/docs/git-ls-remote) describes listing remote
refs and their object IDs without fetching objects into the local repository. `--refs` suppresses
pseudorefs and peeled tag entries; `--exit-code` uses status 2 when no matching refs exist. This
supports a read-only branch list with an ordinary empty state. The docs now call the filter
`--branches`; `--heads` remains an alias and is supported by the installed Git 2.50.1.

[Git's ref-validation documentation](https://git-scm.com/docs/git-check-ref-format) defines the
restrictions on reference names. Its `--branch` option also expands previous-checkout syntax.
Nexestra should validate the literal full `refs/heads/<name>` ref, reject names starting with a
dash, and pass arguments directly to Git without a shell.

[Git's fetch documentation](https://git-scm.com/docs/git-fetch) describes atomic ref updates,
empty `--refmap=` ignoring configured mappings, and `--no-write-fetch-head` avoiding a write to
`FETCH_HEAD`. Reusing source refresh's private destination ref and these flags lets branch
selection obtain a commit without checking out the source clone or moving its existing refs.

[Node 24's StringDecoder documentation](https://nodejs.org/docs/latest-v24.x/api/string_decoder.html)
explains that incomplete multibyte characters are buffered between writes and that an incomplete
final character is replaced when the decoder ends. A real subprocess fixture exposed a related
bug in the existing command transport: independently decoding each chunk corrupted a Vietnamese
branch name and emoji split between chunks. Separate streaming decoders for stdout and stderr
preserve those names while keeping the combined raw-byte output budget.

The web search tool returned HTTP 404. These official pages were fetched directly over HTTPS and
their relevant text was read locally. The design choices and limits below are Nexestra decisions,
not features promised by the cited tools.

## Acceptance criteria

- List existing source branches only after an explicit action. Listing must not change state,
  source-clone refs, checkout, index, or Worker worktrees. Bound rows, name length, bytes and time;
  malformed or omitted rows must make incompleteness visible.
- Preserve the original `defaultBranch`; record a separate `selectedBranch` and source version.
  Legacy records without a source version act as version zero.
- Validate and fetch an explicitly chosen existing branch into a fresh private ref under the
  repository operation lock. Publish the branch, commit and next version together after success.
- Use an expected source version so a stale picker cannot replace a newer selection. A conflict
  requires reloading and an explicit user retry. A fetch failure keeps the previous usable source.
- Future refreshes follow the selected branch. Future Worker assignments use the selected commit;
  existing assignments, including staged, unstaged and untracked files, remain unchanged.
- Keep credentials out of branch-list results, saved metadata and error messages. Use the existing
  process environment allowlist, closed stdin, noninteractive Git and bounded output/time.
  The shared HTTP error boundary also redacts stored credentials from validation, store and
  unexpected error messages; unexpected errors are logged as redacted text instead of raw Error
  objects with potentially sensitive stack or cause fields.
- Cover loading, empty, partial, manual-entry, failure and stale states in the UI. Cancel or ignore
  old requests when the repository or workspace changes. Verify keyboard and light/dark themes.

## Verification status

The subprocess regression fixture reproduced corrupted UTF-8 before the change. All seven focused
process tests pass after the fix, including separate stdout/stderr decoding, incomplete final
characters, callback failure and the combined raw-byte limit. The transport-only `pnpm check`
passed with 365 tests in 29 files, lint, typecheck and both production builds. Branch backend/UI
integration and its final combined gate are still in progress.

## Deliberate limits

This workflow selects existing source branches for future work. It does not create remote branches,
switch existing Worker worktrees, merge, push, or turn the managed clone into an interactive checkout.
Branch listing is an observation of a changing source, not a guaranteed future fetch result. A
deleted branch can fail when selected even if it appeared in the list earlier.
