# Repository source branch selection UI behavior note

Ready repository Knowledge items offer explicit source branch selection. The backend state model
is defined in [ADR 0037](../adr/0037-explicit-repository-source-branch.md); this note records UI
behavior, tests and limits.

## Behavior

- Knowledge details never call the branch API just by opening. A ready repository shows the
  effective source branch (`selectedBranch ?? defaultBranch`, both optional so the effective
  value may be unknown) and a **Change branch** action. Opening that action loads
  `GET /api/knowledge/:id/branches` once.
- The branch list response carries `branches (name + commit)`, `truncated`, `sourceVersion`,
  `selectedBranch` (the EFFECTIVE current branch), and `defaultBranch`. The UI lists available
  branches, marks truncated lists as first-N with a manual-entry hint, and always accepts typed
  branch names; empty lists remain usable through typing. The loaded picker also shows
  `Current source branch: {response.selectedBranch ?? "Not available"}` from that response
  snapshot, so after a conflict the explicit reload displays the fresh effective branch without
  inferring commits from the local option rows.
- Applying sends `POST /api/knowledge/:id/source-branch` with `{ branch, expectedSourceVersion }`.
  Success closes the picker and calls the parent's generation-safe `onChanged` so the detail and
  workspace snapshot update without a bootstrap reload. The notice names the applied branch.
- The picked branch controls future Worker starting points only; existing Worker branches and
  worktrees are untouched, and the explanatory copy says so. The app never auto-applies a branch.
- A `ready` response that carries `refreshError` is not success: the picker stays open, the
  previous effective branch remains, no notice is flashed, and Apply is retryable.
- HTTP 409 (stale source version) shows a conflict panel: Apply is disabled until the user
  explicitly reloads the branch list from the fresh sourceVersion and re-applies. The mutation is
  never silently retried, and typing or selecting a branch does not clear the conflict by itself.
- Branch list load has explicit loading/error/retry states. Opening the picker focuses the branch
  input; Escape closes it and restores focus to **Change branch**. After a successful apply, focus
  returns to **Change branch** through a guarded post-commit effect that runs only once React has
  re-enabled the button (focusing synchronously while it is still disabled is dropped) and the
  disabled state clears. Selecting a listed branch fills the input and focuses Apply; Enter
  submits. Escape is handled in the capture phase so it closes only the picker while the picker is
  open; a second Escape then closes the outer detail dialog.
- Request hygiene mirrors the transcript search dialog: each open and branch-list reload uses its
  own AbortController plus a monotonic load request id; apply uses a separate controller and id.
  When the item id, item `sourceVersion`, or workspace generation changes while an apply is
  pending, that specific apply intent is cancelled immediately (busy state cleared), so its late
  resolution or rejection cannot show an error, open a conflict, close the picker, call
  `onChanged`, or overwrite a newer item. Closing and unmounting abort pending browser requests.
  StrictMode double-effects leave the picker loading and then ready rather than stuck.
- **Refresh source** is disabled while a branch change is pending, follows the new effective
  branch, and stays available when `defaultBranch` is absent but `selectedBranch` exists. Edit and
  Delete are also disabled while the branch mutation is pending. While a refresh is running
  (locally or via `item.refreshing`) the picker is inert: Change branch, Apply, the input, list
  options, Retry, and Reload are disabled, while Cancel and Escape stay usable. A pending apply is
  cancelled when the picker becomes disabled so a racing refresh can never surface as a false
  source-version conflict.
- The UI imports the repository and branch-list types and branch-name length cap from shared
  contracts. Legacy items without `sourceVersion` read as version zero.

## Tests

`RepositoryBranchPicker.test.tsx` (14 tests): explicit-load-only, listed selection, typed selection,
empty and truncated lists, load error + retry, ready-with-refreshError is not success, 409 requires
reload/re-apply and survives input edits until reload, late apply ignored after
close/unmount/sourceVersion change, rejected late apply ignored after generation change, late list
ignored after close, focus/Escape, StrictMode loading recovery.

`App.test.tsx` additions (7 tests): end-to-end apply updates the detail without bootstrap reload,
reopens the picker after success with focus on **Change branch**, selected-over-default effective
branch display, ready+refreshError keeps the old branch and picker, 409 shows the refreshed
current source branch after Reload and requires re-apply with the fresh expectedSourceVersion,
pending apply disables Refresh/Edit/Delete until the response lands, refresh keeps an open picker
inert until it resolves, and Escape closes only the picker first.

## Limits

- No assignment-time branch override or pruning of previous source snapshot refs. If a source
  branch is deleted before fetching, the picker keeps the prior selection and displays the failure.
- The list is capped by the server; the UI only says results are first-N and invites typing.
- Branch names typed by the user are validated by the server. The UI caps input length at 256 to
  match the backend `KNOWLEDGE_BRANCH_NAME_MAX_LENGTH` but does not re-implement Git ref rules.
- An accepted source update can finish after the picker closes. The next refresh of repository
  metadata shows its result; closing the browser request does not roll back a Git operation.
