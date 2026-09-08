# Research: resumable workspaces and editable agent profiles

Research date: 8 September 2026 (Asia/Ho_Chi_Minh).

## Primary sources

- [Slack: Send and read messages](https://slack.com/help/articles/201457107-Send-and-read-messages)
  documents automatically saved unsent drafts and a sidebar entry for finding them. Nexestra already
  stores draft text, but repository inspection found hydration and navigation gaps. The selected
  adaptation is reliable draft restoration plus a visible indication in the owning thread.
- [OpenCode: Agents](https://opencode.ai/docs/agents/) describes specialized profiles with editable
  descriptions, prompts, models, and permissions. This supports completing Nexestra's existing
  profile lifecycle with editing, while retaining Nexestra's mention and credential boundaries.
- [Linear: Workspaces](https://linear.app/docs/workspaces) places workspace settings and workspace
  switching in the workspace menu. Nexestra uses a rail and Settings already; keeping management in
  those controls is a local design inference, not a claim about Linear's rename or reorder behavior.
- [Git fetch](https://git-scm.com/docs/git-fetch) documents fetching objects and updating remote
  tracking refs. A repository refresh must therefore distinguish those refs from the starting commit
  used for a new assignment. [Git diff](https://git-scm.com/docs/git-diff) exposes `--no-ext-diff` and
  `--no-textconv`; a future review surface should disable external diff/conversion programs while
  displaying repository changes. These are constraints for the next repository-management wave.

These sources informed product choices. No usability study or measured productivity improvement is
claimed. Search tooling was unavailable during this pass; the linked official pages were fetched
directly over HTTPS and read locally.

## Selected implementation wave

| Repository gap | Selected behavior | Acceptance evidence |
| --- | --- | --- |
| Leaving a conversation loses the last working thread; draft effects can overwrite saved text. | Remember one valid thread per workspace; honor explicit URLs; expose Draft in navigation; preserve unsent text through navigation and failed sends. | Navigation, hydration, storage-failure, and send-revision tests. |
| Agent creation exposes fields that cannot subsequently be edited. | Reuse profile fields for editing, keep credentials write-only, reject configuration changes while work is reserved or active. | API/UI validation, secret keep/rotate/remove, busy and write-failure tests. |
| Workspace names and order are fixed after creation. | Rename and accessible Move up/down controls in Settings, persisted with stable IDs. | Exact-list validation, concurrent state writes, restart, and UI tests. |
| Manual delegation bypasses the documented Worker lifecycle. | Share the serial queue, persist its triggering user message and canonical run, return queued acceptance, and expose live progress/Stop. | Fake-runner queue, duplicate, failure, interruption, verification, and HTTP acceptance tests. |

The fourth item came from source inspection rather than competitor research. It is required to keep
Nexestra's own serial-agent and canonical-transcript invariants true as Taskboard usage expands.

## Integrated verification

At integration commit `659533a`, `pnpm check` passed: lint, TypeScript, **218 tests in 16 files**, and
both browser/server builds. Node 26 used the command-local `NODE_OPTIONS=--no-experimental-webstorage`
compatibility flag for the jsdom test environment. No default test called a live provider.

Browser checks used a disposable local store and fake Workers. They verified:

- Manual delegation exposes live progress and Stop, rejects profile edits while a Worker is busy,
  and retains interrupted run/tool history after Stop.
- Renaming and reordering workspaces preserves the selected workspace and its active Worker.
- Agent editing keeps credentials write-only; selecting then cancelling key removal retains the
  saved credential while ordinary profile edits persist.
- Drafts survive surface navigation, workspace switches, and reload. A successful send creates one
  user note, clears only the sent draft, and does not resurrect that draft after reload.
- A bare foreign thread URL selects its owning workspace. Switching workspaces on a surface,
  returning to Threads, and reloading stays in the new workspace with its draft intact.

Deterministic tests additionally cover storage denial, later edits during a pending send, delayed
foreign-link responses, and Stop after the completed assignment becomes durable. Multi-file writes
remain ordered writes rather than an atomic transaction, as documented in ADR 0028.

## Remaining candidates

1. **Repository recovery and refresh:** recover a failed initial clone without deleting Knowledge,
   and explicitly refresh a ready repository for future assignments. Inspect Git status and active
   assignments first; existing worktrees and branches must retain their recorded starting state.
2. **Read-only assignment review:** show branch changes before cleanup, including a clear account
   of dirty/untracked files. Establish byte/file caps and path containment before adding any merge UI.
3. **Conversation organization:** rename and archive threads while keeping their single transcript,
   stable links, and active runs. Define how archived threads appear in search and Needs attention.
4. **Knowledge content revisions:** replace document bytes with retained provenance and safe
   handling of active invocations, instead of deleting/recreating the Knowledge identity.

These candidates require their own repository audit and primary-source verification before
implementation. The current wave does not implement them or claim the wider roadmap is complete.
