# Architecture — Milestone M9 fresh rebuild

## Product boundary

M9 is a single-user, local-first control center. The server binds to `127.0.0.1`, the SPA
communicates over HTTP, and the server invokes configured coding harnesses or providers. The two
primary navigation areas are Threads and Surfaces; the initial surfaces are Taskboard, Knowledge,
Whiteboard, Agents, Run history, Needs-work review, and optional declarative custom surfaces.
The far-left rail switches between workspaces, while the adjacent panel owns the Threads, Surfaces,
and Settings navigation. **Needs attention** is available directly from workspace navigation and
collects pending decisions and task failures across the selected workspace. Settings exposes
workspace rename and rail reordering; the stored order is restored on restart.

## Components

```text
React SPA
   │ HTTP + thread SSE
   ▼
Hono API ── FileStore ── state.json / credentials.json
   │                    ├─ threads/<id>.jsonl
   │                    ├─ artifacts/<thread-id>/<artifact-id>
   │                    └─ workspaces/<id>/{knowledge,repositories,worktrees,whiteboard.md}
   ▼
ChatService ── AgentDispatcher ── LocalAgentRunner
                                  ├─ codex exec --json (discussion / delegated task / full)
                                  ├─ opencode run --format json (plan / build)
                                  └─ MasterHarness ── provider HTTP (OpenAI Chat/Responses or Anthropic Messages)
                                                   ├─ built-in tools + user questions
                                                   ├─ durable plan + Worker delegation
                                                   ├─ workspace/user custom tools
                                                   └─ local/remote MCP servers
```

The shared Zod contracts in `src/shared/contracts.ts` define the boundary between browser and server.

## Refresh and rendering model

The SPA performs no periodic requests while the selected workspace is idle. While the visible
thread has queued, running, approval-waiting, or input-waiting work, it opens one Server-Sent Events
connection. The dispatcher publishes phase changes, runtime-emitted reasoning, and accumulated
response text directly, and marks events that require the browser to reload durable messages, runs,
or tools. Browsers without
EventSource retain the one-second active-thread polling fallback. A lightweight workspace activity
endpoint is polled for other active runs, including while the selected thread streams. Each snapshot
updates run status and attention items; when any observed run disappears, the browser refreshes
durable workspace metadata even if other work remains. Delayed results from a previous workspace
are discarded. The dispatcher keeps the live run and response
projection in memory, while JSONL run and tool events remain the durable source used for restart
recovery.

An idle workspace revalidates on window focus, document visibility and visible network-online
events, or the explicit **Refresh workspace** action. Related lifecycle events coalesce into one
read cycle with at most one queued follow-up. Revalidation refreshes bootstrap metadata and the
current bounded history intent; a newer navigation or request keeps ownership of its view.
Each cycle times out after 30 seconds, aborts its reads and permits retry; late responses cannot
apply after cancellation. Hidden tabs discard queued automatic work.
Drafts, selected files and pending submission identities remain unchanged. Surfaces need only
bootstrap metadata, and Files & links retains its on-demand inventory path. Failures expose Retry
while preserving usable data. Browser online status is a hint to attempt a read, never a gate on
loopback access. See [ADR 0040](adr/0040-workspace-resume-revalidation.md).

Harness installation and ChatGPT login status are cached for 30 seconds and explicitly invalidated
by the login flow. In React, search input owns its local state and the transcript is a memoized render
boundary. Runs are grouped by trigger in one pass, so typing does not rebuild message rows and a
transcript refresh does not perform a messages-by-runs nested scan.

Global search uses an editable combobox with keyboard selection and an `aria-activedescendant`
listbox. It searches the current bootstrap data. Thread results navigate to the thread, while task
and knowledge results open their existing detail dialogs directly.

The local search endpoint scans only canonical transcript message events in the selected workspace.
It bounds bytes, lines, line size and retained result metadata, matches after credential redaction,
and reports observed counts plus explicit completeness. Invalid UTF-8, damaged/missing history and
budget limits cannot be presented as an exhaustive no-match result. Complete pages accept offsets
through 10,000; they are not snapshot-stable cursors. No index, provider call or persistence mutation
is part of search. See [ADR 0034](adr/0034-transcript-message-search.md).

A separate Messages dialog sends explicit phrase/thread/archive filters to the local transcript
search endpoint. Editing a filter clears old results and aborts pending requests; workspace changes
invalidate the dialog. A fresh modal request preserves the current focus across background metadata
updates. Complete result pages are deduplicated by thread/message identity; partial scans offer no
continuation. Search results navigate to `/threads/<id>?message=<id>`, which resolves foreign
workspace links, opens Messages, and focuses the matching group. Automatic bottom scrolling stays
paused until **Show latest** clears the target. Archived conversations remain read-only. See
[ADR 0035](adr/0035-message-deep-links.md).

Saved message rows also expose that route through **Copy message link**. The button builds an
absolute URL for the current origin using stored thread and message IDs, waits for clipboard
confirmation, and reveals a selectable URL when copying is unavailable or denied. Its feedback
is component state; it adds no transcript, run or server-side sharing record.

Messages uses `/api/threads/:id/history` with a 50-message window. Stable message-ID anchors select
older, newer or centered pages; a missing linked target is established across the index rather than
inferred from absence in the current page. A startup-built in-memory byte-offset index locates
selected messages, their artifacts and the latest associated run/tool records in canonical JSONL.
Durable appends extend the index. Whole-thread active runs are returned separately from page runs,
so reading history does not hide current work or stop its SSE subscription. Historical refreshes
keep their anchor. Needs attention resolves a live run to its trigger message before navigation.
Files & links explicitly loads the complete legacy thread response when opened. See
[ADR 0038](adr/0038-bounded-conversation-history-pagination.md).

Draft text, pending send identities, the theme, and navigation preferences are browser-persisted UI state. An
App-owned `ConversationState` keeps drafts under `nexestra.draft.<workspaceId>:<threadId>`, reads
only on first access, and clears only the sent revision after a successful send; the empty value is a tombstone that also retires legacy thread-only keys. The sidebar shows a **Draft**
badge per thread, and each workspace remembers its last opened thread under
`nexestra.lastThread.<workspaceId>` so the Threads entry returns to the active conversation. Guarded
storage calls degrade to in-memory text with a visible note instead of interrupting the composer. Foreign bare deep links are resolved once through `/api/threads/:id/metadata` with workspace and route generation guards, never by polling or loading a transcript.
See [ADR 0025](adr/0025-app-scoped-conversation-state.md).

An App-owned `ReadState` stores versioned read-through message counts under
`nexestra.readState.1.<workspaceId>`. A workspace with no valid saved marker baselines existing
threads to current counts. Restored workspaces retain their markers; newly discovered conversations
start at zero. Unread badges subtract these counts from current thread metadata, including archived
threads in the workspace total. Automatic acknowledgement uses the loaded latest page's
`lastMessageIndex`, gated by current transcript-bottom geometry, document visibility, focus and
covering dialogs. Reading older or linked pages and Files & links does not advance the marker.
Explicit mark-all batches the currently known counts into one write without navigation or API calls.
Storage contains only identities and counts, bounded to 5,000 threads and 256 KiB per workspace.
Tabs merge markers monotonically and repair stale snapshots through same-origin storage events;
failed storage leaves the current session's markers in memory. See
[ADR 0041](adr/0041-browser-local-conversation-read-state.md).

`unreadNavigation` projects workspace-scoped All/Unread lists in active-then-archived order,
retaining the selected read row in Unread. App owns a temporary filter per workspace; reload
starts with All. Next unread resolves from current metadata/read markers and opens the first unread message,
including explicit archived targets. Empty results do not request history. App also owns selected
File arrays per workspace/thread, preserving object identity across view unmounts and retiring only
submitted objects when their request is still current. Older responses retain files reused by newer
pending submissions. Explicit opening of Messages has its own signal so asynchronous send scrolling
cannot override a Files view. See [ADR 0042](adr/0042-unread-conversation-navigation.md).

First unread uses a 1-based `at` history anchor computed from the current read-through marker. The
server resolves that ordinal directly from its canonical message offset index and returns one bounded
page plus the actual message ID. App then replaces the transient lookup with an ordinary `around`
intent and canonical `?message=` URL, reusing existing focus and scroll behavior without a second
request. Missing ordinals return a bounded recent page with an explicit notice and no invented ID.
Pending lookups coalesce; request/workspace guards and browser Back prevent stale responses from
overriding navigation. Explicit Mark read writes only the selected conversation's maximum known
metadata/page count to browser storage, without moving the viewport or calling the server. Neither
ordinal nor linked history automatically acknowledges messages. See
[ADR 0044](adr/0044-first-unread-message-navigation.md).

`SubmissionState` owns pending message request IDs independently of a mounted conversation. Its
workspace/thread-scoped entry records a UUID, payload fingerprint, timestamp and bounded file
descriptors. WebCrypto hashes file bytes before a send; the bytes themselves stay in browser `File`
objects. A confirmed response retires only its captured request ID and draft revision. Unconfirmed
attachment submissions require the original files or an explicit new send after reload. Guarded
storage and memory tombstones prevent a failed storage removal from reviving a retired identity in
the current App session. See [ADR 0039](adr/0039-recoverable-message-submission.md).

The attention projection uses active dispatcher runs plus current task, assignment, agent, and
thread metadata. Bootstrap and the activity endpoint return the same shared item shape. Waiting
approval/input runs are listed first. Tasks contribute at most one item based on their status and
latest assignment; done tasks and superseded failures are omitted. Building the projection does not
read transcripts or persist another queue. See [ADR 0024](adr/0024-workspace-attention-projection.md).
If a new task appears in attention before the cached task list is refreshed, Inspect loads that task
by ID before opening its process dialog. The result is discarded if the user switches workspaces.
An invalid saved workspace selection is cleared once during initial startup so a replaced local data
directory cannot leave the browser stuck at a missing-workspace error; explicit switch failures
remain visible.

Run history lists the latest durable lifecycle summary per run from the canonical transcript
indices, including ordinary terminal chat runs and archived conversations. `/api/runs` validates
workspace-owned filters and uses creation-order keyset cursors bound to those filters and the
bounded page size. Invalid or unavailable conversations are omitted with explicit coverage. The
in-memory summary projection is rebuilt at startup and extended after durable appends; warm listing
sorts cached summaries without reading whole transcripts. The surface retains one page of run
objects plus previous cursors. Open run uses the canonical trigger message link, with app-owned
draft/file retention and immediate invalidation on workspace switches. Global Refresh/resume also
refreshes the mounted listing. Terminal rows derive wall-clock duration from lifecycle timestamps;
custom-provider usage, when reported, is normalized to optional input/output/total token counts.
Each filtered response also includes aggregate run, duration, token, and usage-coverage metrics.
See [ADR 0045](adr/0045-workspace-run-history.md), [ADR 0049](adr/0049-run-duration-metrics.md),
and [ADR 0050](adr/0050-provider-usage-telemetry.md). It also includes a bounded per-agent
breakdown using the same filters and complete cached summary set. See [ADR 0052](adr/0052-run-history-agent-comparison.md).
Agents may optionally carry user-supplied USD-per-million token rates; when input and output rates
are present, the per-agent breakdown includes an estimated cost with cached-input pricing applied.
Each run-history row also carries that derived estimate when available, including in the bounded
run-history export, so a retry or individual task can be compared without reconstructing aggregate
totals. These are current local estimates rather than provider invoices. See [ADR 0053](adr/0053-agent-pricing-profiles.md)
and [ADR 0073](adr/0073-per-run-cost-visibility.md).
The same filtered summary now includes the optional total estimated cost and the number of runs
that contributed to it, so partial pricing coverage is visible in the UI and export. See
[ADR 0074](adr/0074-run-history-cost-summary.md).
Failed and interrupted summaries also carry a safe failure kind, never raw provider or command
output, so the monitoring list can guide recovery without widening the response's secret boundary.
See [ADR 0059](adr/0059-safe-run-failure-kinds.md).
The header can export the currently loaded page, active filters, coverage, cursors, and complete
filtered summary as a bounded browser-generated `nexestra.run-history` JSON packet. See [ADR 0069](adr/0069-run-history-telemetry-export.md).

Agent messages expose optional helpful/needs-work feedback controls. One bounded rating per message
is stored in workspace metadata, returned with history, and included in workspace exports; the
canonical transcript remains unchanged. Generated replies also carry the producing run ID. Run
history attributes ratings to that exact run, so retries and multiple agents sharing one trigger do
not inflate each other's counts. Legacy replies without provenance are counted only when their
trigger maps to one unambiguous run. The surface shows helpful/needs-work totals as explicit user
signals, without inventing an automatic quality score. See [ADR 0054](adr/0054-message-quality-feedback.md)
and [ADR 0055](adr/0055-run-quality-attribution.md).

Message content is stored and transported as unchanged Markdown. The browser renders it with
GitHub Flavored Markdown and KaTeX inside the memoized transcript boundary. Raw HTML parsing is not
enabled, the Markdown renderer removes unsafe URL schemes, and HTTP(S) links use isolated tabs.
Agent and knowledge-reference highlighting is applied to rendered text nodes while links and code
remain untouched.

Conversation chrome and content use scoped mobile layout rules after the base stylesheet. Short
mobile viewports scroll the header group while preserving the transcript's existing scroll root
and bounding the composer. Prose wraps; code, tables and display math use named keyboard scroll
regions. Refresh errors use a second mobile topbar row, with search results anchored beneath it.
See [ADR 0043](adr/0043-responsive-conversation-containment.md).

## Persistence

`state.json` stores workspaces, agent profiles, thread metadata, tasks, knowledge metadata, and
Worker assignments. Every record carries a workspace ID. Handles and thread slugs are unique only
within their workspace, and task references cannot cross workspace boundaries. Creating a
workspace seeds a `general` thread. Renaming updates the workspace name and re-derives a unique
slug within the current list. Reordering stores the exact workspace ID list. The store serializes
these writes, so a stale reorder from another window is rejected instead of silently dropping a
concurrent workspace creation. Settings shows the resulting error and can reload the workspace
list from the server without restarting the app.
Version 1 state is migrated in place to version 2 by assigning every existing record to a default
`Nexestra` workspace; record IDs and transcript paths do not change. Version 2 state migrates to
version 3 by adding the first Master tool permissions; version 3 migrates to version 4 by adding the
complete tool matrix. Version 4 migrates to version 5 by replacing that matrix with one `ask`,
`auto`, or `full` access mode. Version 5 migrates to version 6 by adding empty knowledge and
assignment collections. Version 6 migrates to version 7 by adding the task verification contract.
Message capture creates a Knowledge document from the canonical message bytes with known-credential
redaction and source thread/message IDs. It invokes no agent and preserves the original transcript.
See [ADR 0051](adr/0051-message-knowledge-capture.md).
State writes use a temporary file followed by an atomic rename. The
separate `credentials.json` file has mode `0600` and stores only custom API keys by agent ID.

Workspace export captures a selected state projection and owned source file identities under the
store write barrier, then streams redacted canonical JSONL and exact uploads/document revisions
into a private temporary ZIP. It checks identities again before handoff and fails on changed,
missing, unsafe or corrupt sources. `GET /api/workspaces/:id/export` sends the completed archive
with no-store download headers and disposes it after delivery or cancellation. One export per store
remains reserved through the download. Source data, output, entry count and preparation time are
bounded; browser download also has a deadline and ignores stale workspace results.
The versioned manifest records the SHA-256 and size of each delivered payload. Known credentials
are redacted from structured text; a literal known credential in original upload/document bytes
blocks export. Credential/auth files, repository/worktree contents, browser state and unreferenced
files are excluded. Settings and `/export workspace` open an inert dialog before explicit download.
See [ADR 0046](adr/0046-portable-workspace-export.md) for ownership, snapshot and format details.

Workspace archive inspection runs entirely in a browser module Worker. An explicit local File is
checked against the ZIP records and export manifest; no inspection upload/API or persisted state is
created. The client owns cancellation, a 45-second deadline and stale-result guards. The shared
engine supports the stored ZIP v1 profile, validates layout and bounds, and checks CRC/SHA-256 one
payload at a time. The report identifies the archive's workspace and paginates its verified files.
WebCrypto requires one complete capped entry per digest. Matching hashes do not validate deep
state/transcript semantics or establish authenticity, completeness or the ability to restore the data. See
[ADR 0047](adr/0047-local-workspace-archive-inspection.md) for the supported profile and limitations.

The export and inspection dialogs load through separate dynamic imports on explicit opening.
`WorkspaceArchiveDialog` shows an immediately usable loading/error shell and restores focus across
the content handoff. A per-kind registry caches component functions, coalesces pending imports and
removes failed/timed-out attempts after a 15-second deadline. UI generations reject late results
after close, retry or workspace changes. Native imports cannot be aborted; code may finish loading
after the UI detaches, without starting archive work. Retry is subject to the browser's module
cache. The standard Vite manifest records initial and dynamic dependency graphs for build checks.
See [ADR 0048](adr/0048-deferred-workspace-archive-dialogs.md).

Permanent agent deletion removes the profile and its custom credential, clears matching task
assignments, and releases the handle for reuse. Credential removal is persisted before public state
so an interrupted multi-file write favors removing the secret. Thread JSONL files are never rewritten
for agent deletion; historical author and mention snapshots remain part of the canonical transcript.

Agent profile updates use the same write order and never touch transcript files. Custom Master
updates are write-only: an omitted or blank API key keeps the stored key, a new key rotates it, and
`removeCredential: true` deletes it. The credential file is written first and rolled back if the
public state write fails, so metadata cannot claim a credential the file lacks.

Task and Knowledge metadata support create, detail, update, and permanent-delete operations.
Deleting a task is rejected while one of its Worker assignments is queued or running. Historical
assignment and transcript events are retained after task deletion. Deleting repository knowledge is
also rejected while cloning or while a related assignment is active. Repository clones are
first created in a `source.retrying-*` staging sibling and atomically published only when
the destination is absent or empty, so a failed clone can be retried from the failed detail card
without changing the record's id, `#handle`, source, or creation time. An interrupted
clone is marked failed at startup; an existing matching clone can be adopted after provenance
checks. Unused Knowledge storage is
removed; repository storage with assignment history is retained so its worktrees remain inspectable.
Existing message text and stable historical references are never rewritten.

Thread rename changes only metadata and derives a unique slug across active and archived threads
in the workspace. Archive keeps the same ID, JSONL file and artifact paths, and Restore reopens the
conversation. Dispatcher thread reservations span sends, retries and delegations; archival checks
both those reservations and durable active runs/assignments. Archived threads reject new activity
before persistence while retaining reads, exports and historical task inspection. The sidebar has
separate active and archived lists, and ordinary last-thread resolution uses active threads. See
[ADR 0031](adr/0031-thread-rename-and-archive.md).

Knowledge document versions keep immutable bytes in a per-item revisions directory. The current
document's storage path points at its selected revision. Replacement writes a new private file
before publishing cloned state metadata; restoring copies a historical version into a new revision.
Both mutations require the expected current revision, so stale edits fail explicitly. New user
messages pin the selected document revision, with legacy bytes captured before their first pinned
reference. Older transcript references without a revision retain their documented current-content
fallback; they are never rewritten to invent historical provenance. The version list and version
download endpoints remain local, with downloads served as attachments and `nosniff`.
See [ADR 0032](adr/0032-revision-history.md).

An explicit document preview endpoint resolves the current or requested immutable revision and
returns bounded plain text. It verifies a revision's complete checksum before returning content,
rejects files beyond the upload cap and invalid UTF-8, and redacts known credentials in text and
labels. The retained prefix is 128 KiB plus bounded redaction lookahead; redaction can expand the
returned text. Unsupported content uses a download fallback. Legacy documents without a recorded
revision remain read-only and acquire no new provenance from a preview. The inline panel discards
old responses when its version/document/workspace changes and makes the scrollable text accessible
to keyboard readers. See [ADR 0036](adr/0036-knowledge-preview.md).

Each thread has one canonical JSONL file. The `message.created`, `artifact.created`, `run.updated`,
and `tool.updated` events use a monotonically increasing sequence. Artifact metadata and message
IDs are committed in the same append; uploaded bytes live under a thread-scoped private directory.
User messages are appended and fsynced before agents are queued. Read projections select messages
and artifacts by sequence and the final state of each run. On startup, only an incomplete JSONL tail
is truncated. After a restart, queued, running, approval-waiting, or input-waiting runs are completed
if their replies were fsynced; otherwise, they and any unfinished tools are marked interrupted and
can be retried.

Keyed user messages carry a private `submission` receipt in their canonical `message.created`
event. It stores hashes of the normalized UUID and the server-verified payload, rather than a
second transcript or cached HTTP response. Startup reconstructs receipt offsets; the write barrier
and per-request dispatch lock serialize repeated submissions. Same-key payload changes fail with
409. Confirmation returns the original message, Knowledge pins and artifact identities with current
durable run records. Missing initial runs can be reconciled, while existing running or terminal runs
are never repeated by confirmation. Archived confirmation has no new dispatch side effects.

The upload boundary validates file count and size before converting multipart files to byte buffers.
Images are classified from a small MIME allowlist; SVG and every other file type are downloaded with
`nosniff`. HTTP(S) URLs are indexed from both user and agent messages. Markdown links and inline-code
paths are indexed only when they resolve through a real path to a regular file inside the workspace;
app data and Git internals are excluded. The content endpoint repeats that containment check so a
changed symlink cannot escape the workspace.

Link reference display names are bounded to 255 characters with an ellipsis; the normalized full
URL remains the identity, up to the existing 4096-character URL limit. This does not rewrite the
message or alter canonical append/replay behavior.

## Mention and dispatch

`ChatService` resolves handles case-insensitively inside the thread's workspace and removes
duplicates. Unknown handles remain plain text. Each known handle creates one run; disabled or
unavailable agents create explicit failed runs. The dispatcher maintains one promise queue per
agent, so each agent replies serially while different agents can run in parallel. Every invocation
is tied to the exact triggering message ID, content, and artifacts; stale or duplicate retries are
rejected. Transient runtime failures receive at most two automatic retries with bounded backoff;
each retry has a new durable run ID and a monotonically increasing attempt number. Known stored
credentials are redacted from agent output before it goes to the transcript, and output does not
pass through the mention parser.

`ChatService` also resolves `#handles` inside the thread workspace and stores stable knowledge IDs
on the message. Code spans and fenced code blocks are excluded from reference parsing. An
invocation receives only the knowledge explicitly referenced by its trigger: text documents carry
bounded content, while binary documents and repositories carry managed local paths.

Chat reserves each resolved agent before persisting the user's message, without starting dispatch.
Deletion is rejected while a reservation or per-agent queue is pending or running, and a deletion
tombstone prevents new reservations until the profile update finishes. After an agent is deleted, a
newly typed reference to its old handle is plain text unless that handle has been reused by another
agent. Historical failed runs for a deleted profile cannot be retried.

Configuration edits reuse that tombstone: a PATCH changing anything other than `enabled` or
`archived` is rejected while the agent is busy, queued, reserved, or already being changed, and
falls back to the direct store call for pure toggles. Update validation matches creation, rejects
unknown and immutable fields (kind, workspace, ID), and re-checks handle uniqueness.

## Planning and Worker delegation

The provider-neutral Master tool session owns a per-run set of planned task IDs. `plan` creates
durable Taskboard tasks linked to the triggering thread. `delegate` accepts only a task returned by
that same session, an enabled Worker, and a ready repository in the thread's workspace. The runtime
lists those repositories in the Master context, so the triggering message does not need to include
the repository handle. When both a Worker and ready repository are available, a custom-provider
Master cannot return its final answer while that set still contains undelegated tasks; the runtime
adds a corrective turn and keeps the tool loop active.

Each repository is cloned once under the owning workspace. Every assignment creates a unique
`nexestra/<assignment-id>` branch and a Git worktree under the same managed workspace tree. The
ready repository detail view can explicitly select or refresh a source branch into a new private
Git ref and publish a `sourceCommit` for future worktree preparations. The original `defaultBranch`
is retained; `selectedBranch` overrides it after an explicit choice. A read-only, bounded branch
list is loaded on demand. Selection requires the list's `sourceVersion`, with an absent legacy
version interpreted as zero. Successful selection and refresh advance the version so a stale
picker cannot overwrite newer source metadata. A preparation selects the latest published commit
when it starts; before the first selection or refresh it uses clone HEAD. Fetch preserves
the clone's checkout and index, origin refs, and existing assignments. Refresh failure retains the
last usable selection and `ready` status. A persisted `refreshing` flag guards edit/delete and is
recovered at restart; known errors are redacted. See
[ADR 0033](adr/0033-explicit-repository-source-refresh.md) and
[ADR 0037](adr/0037-explicit-repository-source-branch.md). The
dispatcher reuses the normal per-agent queue, so one Worker remains serial while different Workers
can execute concurrently. A delegated Worker receives task mode, the worktree as its process cwd,
the shared transcript snapshot, and the selected repository as knowledge. Success marks the
assignment complete, then the dispatcher runs the task's user-owned verification command in the
assignment worktree. Exit code zero marks the task done; any other exit code marks it blocked and
stores the redacted, bounded output and exit code. Worker failure records a redacted error and
returns the task to To do.
Branches and worktrees are retained for inspection. Nexestra never merges or pushes.
A finished assignment can be cleaned up explicitly from its process dialog. Cleanup uses Git's
non-forced worktree removal, so dirty or untracked work is refused, records `worktreeCleanedAt`,
and leaves the branch and durable run history intact.
  After the worktree is removed, the same dialog can delete the assignment branch. Branch cleanup uses
  Git's non-forced `branch -d`, records `branchDeletedAt`, and refuses unmerged branches.

Worktree preparation captures the starting commit before the Worker runs. The process dialog exposes
a read-only on-demand Git review that compares that base with the assigned branch and worktree:
committed, staged, and unstaged summaries, a bounded unified diff, and untracked paths. It verifies
repository/branch identity and path containment, refuses custom Git filters, and never merges,
applies, resets, or cleans up. Older assignments without a recorded base are reported as `legacy`.
See [ADR 0030](adr/0030-read-only-assignment-git-review.md).
The process dialog can also retry the latest failed, interrupted, or verification-blocked
assignment with its same Worker and repository. Retry creates a new assignment, branch, and worktree
while preserving all historical assignment and run records.
A task with no assignment can be delegated directly from its process dialog by selecting an enabled
Worker and ready repository; a linked thread remains mandatory.

Master and manual delegation use one assignment lifecycle. A manual request first appends a user
message with the selected Worker's explicit mention, then persists its assignment and canonical run.
The HTTP endpoint returns `202` with the queued assignment so the existing process view can observe
and stop it immediately. An in-memory task reservation rejects duplicate starts while persistence is
in flight; the per-Worker queue includes worktree preparation, execution, and verification. Run/tool
failures and interruptions remain durable, and a failed start releases its reservations. Stopping
selects an active assignment even if an older historical assignment was updated later. See
[ADR 0028](adr/0028-shared-worker-assignment-lifecycle.md).

Each delegated assignment owns an in-memory abort controller from before it is queued until its
final cleanup. Stopping a task aborts both Git worktree preparation and the Worker harness process;
CLI harnesses forward the signal to the detached process group and escalate from TERM to KILL after
the normal grace period. The assignment, run, and unfinished tool calls become `interrupted`, while
the task returns to To do and is unassigned. A stop request also repairs stale queued/running state
left without an in-memory controller after a restart.

Ordinary mentioned runs also own an abort controller from queue creation. The conversation's Stop
action aborts CLI or custom-provider work, settles pending interaction promises, and persists an
`interrupted` run without entering automatic retry. Assignment IDs remain owned by Taskboard so
stopping them can also restore task and worktree state. Custom HTTP requests combine the run signal
with their bounded timeout; a late provider result is rejected before a reply can be appended.

The assignment ID is also the delegated Worker's durable run ID in the canonical thread JSONL.
Native Worker tool events are normalized and persisted against that run, while reasoning and
partial text remain in the dispatcher's bounded live projection. The Taskboard process endpoint
joins task, every assignment attempt, the latest run, tool history, and current live activity. Its
dialog subscribes to the
same thread SSE stream as chat, with an active-only polling fallback when EventSource is unavailable.

## Agent runtimes

Worker profiles select either `codex` or `opencode`, with optional model and reasoning-effort
overrides. Worker chat turns require read-only discussion mode. Delegated task turns use
workspace-write for Codex and OpenCode's build agent, scoped to the assignment worktree. Codex maps the overrides to
`--model` and `model_reasoning_effort`; OpenCode maps them to `--model` and its provider-specific
`--variant`. Missing overrides preserve the harness defaults. Master profiles select one of the
following:

- ChatGPT: maps Ask to Codex read-only, Auto to workspace-write with automatic approval review,
  and Full access to Codex's explicit sandbox-and-approval bypass; device-login output remains in
  memory, and tokens never enter the app.
- Custom: uses OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages with an API root,
  model, optional API key, and the provider-neutral Master tool loop.

Codex receives safe raster images through `--image`; OpenCode receives each local artifact through
`--file`. Custom providers receive safe raster images in the selected protocol shape (data URLs for
OpenAI-compatible protocols and base64 image blocks for Anthropic Messages) and up to 512 KB of
attached text context. Image provider payloads are capped at 10 MB; larger artifacts remain indexed
but are represented only by metadata.

The Master tool registry provides repository list, glob, grep, read, exact edit, file write,
multi-file patch, bounded shell, skill loading, per-run todos, bounded public web fetch/search,
interactive questions, durable planning, and Worker delegation. LSP is deliberately excluded. Each profile selects one access mode. Ask
allows contextual tools directly and pauses edits, shell, web, and extensions. Auto allows all
built-ins and pauses custom or MCP tools. Full access removes tool approval prompts. An asked tool
is written to the thread and pauses its run until the user decides; a question pauses in a distinct
input state until the local user responds. Multiple calls from one model step execute concurrently,
and a run stays paused until all outstanding approvals or questions are resolved. File tools accept
relative paths and absolute paths inside the repository, reject traversal and escaping symlinks,
and protect Nexestra data and credentials. Workspace, data-root, and absolute-path comparisons use
canonical physical paths so symlink aliases such as macOS `/var` versus `/private/var` cannot bypass
or break containment checks. `read` also accepts exact absolute paths allowlisted from
the triggering message, loaded skill, or saved large tool output; that allowlist does not extend to
search or mutation tools. Tool loops stop after twelve rounds or three consecutive identical calls.

One tool session is created per custom-provider invocation. It reads optional
`nexestra.config.json`, discovers skills and OpenCode-style custom modules, connects configured MCP
servers, and closes all MCP clients after the provider finishes. Local MCP uses stdio; remote MCP
uses Streamable HTTP. Custom and MCP tools receive normalized names and share the `external`
permission boundary. Workspace permission patterns use last-match-wins ordering and may narrow, but
never widen, the access mode.
Search/list tools use ripgrep's `.gitignore` and `.ignore` behavior plus configured patterns, with
hard exclusions for app data and credentials. Web fetch validates DNS and every redirect against
private address ranges before reading a capped textual response.

Built-in schemas expose OpenCode-compatible argument names. Read can list directories, streams
large UTF-8 files with line and byte caps, and reports offsets for continuation. Shell defaults to
120 seconds and accepts a repository `workdir`. Results over 2,000 lines or 50 KB are reduced to a
head or tail preview; the full redacted result is stored in the protected run directory and added
to the current invocation's exact read allowlist. Custom-provider requests retry transient network,
408, 409, 429, and 5xx failures with bounded backoff and `Retry-After` support.

Custom Chat Completions, Responses, and Anthropic Messages requests use their native SSE streaming
protocols. Reasoning and text deltas update the in-memory run projection and are replaced by one
final agent message after completion. Responses requests ask for an automatic reasoning summary and parse both official
reasoning-summary and reasoning-text deltas; compatible Chat Completions providers may expose
reasoning through `reasoning_content` or `reasoning`. Codex
`exec --json` and OpenCode `run --format json --thinking` stdout is parsed incrementally, including
records split across process chunks and tolerate UTF-8 byte-order marks or interleaved diagnostics
without dropping later valid events. Native CLI tool events are normalized into the same durable
`tool.updated` history used by the provider-neutral Master. Reasoning content is redacted, bounded,
and kept only in the process-local run projection. The UI presents it in a collapsed disclosure
while the run is active. After successful completion, the run row—including thinking and tool
cards—is hidden and only the durable final agent message remains visible.

Harness and shell child processes close stdin, enforce timeouts and output caps, kill the process group, and inherit
only allowlisted environment variables to reduce the risk of exposing server secrets. A timeout
sends TERM, then KILL after a grace period, and reports an error only after the process exits.
Local MCP is the deliberate exception: its stdio transport owns stdin for JSON-RPC and is closed
with the per-run tool session.

## Security model

The application trusts the current OS user and user-supplied custom endpoints. The server binds only
to loopback and rejects browser mutations whose Origin is outside loopback. Codex CLI manages OAuth
tokens. Custom API keys remain plaintext at rest in a `0600` file, which fits the local single-user
threat model but does not replace an OS keychain. Custom base URLs may not contain user info, a
query, or a fragment; remote endpoints require HTTPS, while HTTP is permitted only on loopback.
Provider responses have a byte limit enforced before or while parsing.
Only redacted tool metadata and non-content summaries enter the canonical transcript. Large redacted
tool results are stored as private `0600` run files so the same invocation can continue reading
them; known custom-provider credentials are redacted. Custom-provider shell commands still run with the
current OS user's authority, so Ask is the default and broader modes should only be selected for
trusted providers. ChatGPT Auto access instead relies on the Codex workspace-write sandbox; its
Full access mode is deliberately explicit because it bypasses that sandbox.

Git repository URLs with embedded usernames, passwords, query parameters, or fragments are rejected
before metadata is written, so tokens cannot enter `state.json` or clone errors. Private repository
access may use the current OS user's existing SSH and Git configuration; Nexestra does not store Git
credentials.

## Known gaps

- Conversation reflow is verified with Chromium CSS viewport overrides down to 320×480; physical
  software keyboards, other browser engines and full surface/modal reflow need separate checks.
  Short screens use scrollable header and composer areas. The existing 4096-character artifact
  URL bound still applies to automatic reference indexing.

- Recoverable submissions require a client request ID; legacy unkeyed calls remain independent.
  Receipt metadata grows with retained user messages and is rebuilt from JSONL at startup. Replay
  reconciliation reads durable thread runs; this is separate from bounded history-page reads.
  Browser storage may be denied or cleared, and file bytes are not persisted by the composer.
  Explicit run retries and the existing automatic retry policy can invoke a harness again; message
  confirmation does not provide exactly-once external effects or multi-process coordination.

- Conversation history pages avoid whole-log reads after startup, but startup still scans the
  logs and the in-memory offset index grows with record counts. Oversized page/event reads fail
  visibly. Files & links, Markdown export and agent context retain full-history reads. Finite
  pages replace their predecessor; the app does not virtualize one continuous transcript.

- Needs attention reflects the selected workspace's current conditions. It has no historical
  notification log, snoozing, dismissal, desktop notifications, or cross-workspace
  monitoring. Run history separately lists ordinary failed chat turns and links to their thread.
  Changes from another client are
  discovered on return, a visible online event or explicit refresh; idle clients do not continuously
  exchange updates.

- Run history adds O(runs) summary memory and sorts matching runs per request under the store's
  write serialization. Its coverage describes the cached index; external transcript edits require
  a restart. Filtered pages are live and can change as statuses update. Filters/page position reset
  after leaving the surface, and deleted agents are labeled Unknown. It has no background polling,
  raw run-output search, cross-workspace aggregation or batch run actions. The browser offers an
  opt-in 15-second refresh for the newest page, but there is no default or server-side background
  polling. Failed and interrupted rows can be retried individually through the existing guarded retry command. History exposes only
  a bounded failure kind; exact error text remains in the canonical conversation view. Delegated
  Worker rows optionally include a redacted Taskboard title derived from their assignment ID; legacy
  and ordinary runs omit that context.

- Quality ratings are explicit single-user observations. They are attributed only when provenance
  resolves to one run, and the Needs-work review surface provides a bounded, redacted queue for
  revisiting negative replies across the workspace. It links to the canonical message but does not
  auto-resolve, rewrite prompts, or silently promote content. Message capture still opens a review
  dialog before promoting the unchanged, provenance-linked source into Knowledge; content correction
  remains an explicit edit after capture. Needs-work ratings can carry an optional bounded note and
  an explicit open/resolved review status; resolving changes metadata only. Review queue responses
  also include a filter-scoped total for the current snapshot, while keyset pagination and coverage
  warnings remain unchanged. Each queue row can open the same capture dialog directly; the bounded
  queue excerpt is context only and the server reads the canonical transcript by ID. When available,
  rows also include the redacted, 800-character user prompt identified by the reply's durable
  `triggerMessageId`; missing provenance omits that optional context. The browser can export up to
  200 loaded rows as a typed `nexestra.review-cases` JSON packet for offline evaluation or prompt
  improvement; the packet contains only the queue projection and never reads transcript files. The
  queue supports optional workspace-scoped agent and thread filters; keyset cursors encode those
  filters and are rejected when reused with a different selection. Changing a filter resets to the
  first page, and exports record the active filter IDs for reproducibility.

- Optional `surfaces` entries in `nexestra.config.json` compose domain-specific navigation cards.
  Their actions are an allowlisted set of trusted surfaces and their labels are bounded/redacted
  before bootstrap. Cards for Taskboard, Knowledge, Attention, and Agents show live counts from
  the selected workspace; Run history and Needs-work review remain direct links. The browser
  evaluates no configured code, markup, URL, or command. Data-backed widgets and custom forms are
  intentionally future work.

- Taskboard's completed Worker process response may include a bounded `sourceMessage` projection for
  the latest assignment: the canonical agent reply with the assignment run ID. This powers a direct
  reviewed Knowledge capture action while the server rereads the transcript by thread/message ID;
  assignment result text is presentation-only and legacy replies without provenance are omitted.

- Whiteboard is a built-in workspace surface backed by `workspaces/<workspaceId>/whiteboard.md`.
  GET and PUT responses are workspace-scoped and redact known credentials. Markdown is bounded to
  64 KiB of UTF-8, written atomically with mode `0600`, and treated as user notes only; it cannot
  dispatch agents or execute configured content. Saved notes are included in workspace exports as
  a separately typed, redacted `whiteboard` entry.

- Workspace export has no import/restore workflow and is not a complete backup. Snapshot inventory
  scans transcripts under the write barrier before a second read for ZIP generation. Stored ZIP
  entries avoid compression work; the browser holds a bounded ZIP Blob. Known-credential redaction
  cannot discover other secrets or decode arbitrary binary encodings. Hashes are integrity checks,
  not signatures. A process crash can leave a private archive in operating-system temporary storage.

- Conversation unread state belongs to one browser profile and origin. It counts all canonical
  messages and uses a read-through count, not a per-message receipt or proof of attention. Existing
  history is baselined on first use; browser storage loss can reset those markers. Cross-tab merges
  are best effort because localStorage read/write is not an atomic transaction. Markers do not
  synchronize between devices or recover a data directory replaced with shorter history.
  Unread filters reset on reload. First/Next unread uses known metadata in the selected workspace;
  the ordinal resolves once to a stable message ID. Refresh or workspace revalidation discovers
  additional idle activity; navigation itself does not poll other conversations. Selected files survive navigation in memory
  only, so reload requires selecting them again. Several drafts can keep several composer-sized
  file buckets until removed, sent, or the tab closes.

- App-native `plan` and `delegate` are currently available to custom OpenAI-compatible and
  Anthropic Messages Masters.
  ChatGPT OAuth Masters run through Codex CLI and do not yet receive this bridge.
- Assignment branches can be deleted only when Git confirms they are merged; merge and push are not
  yet exposed. Finished worktrees can be removed explicitly, but dirty or untracked work is refused.
  A ready repository can explicitly select and refresh an existing source branch for future Worker
  assignments; branch creation, pull and merge are not exposed. Branch listing is bounded and can
  become stale before selection; a missing source branch is a visible fetch failure. Private refresh
  refs are retained without automatic pruning. Branch deletion still uses Git's non-forced merged check against its
  upstream or the clone HEAD, so even an unchanged branch from a refreshed source can require the
  clone's integration branch to be advanced manually before Git allows deletion.
- Document versions have no automatic retention limit or pruning. Permanent Knowledge deletion
  removes its versions, so historical references to a deleted item cannot load those bytes. Old
  messages without a pinned revision use current contents. Changing a repository source still
  requires deleting and creating the item again.
- A crash during cloning can leave a `source.retrying-*` staging directory. It is preserved for
  manual review instead of being auto-removed, because no ownership record exists for it.
- Tasks created before the delegation-completion guard may remain unassigned; their process dialog
  reports that state, but does not retroactively start a Worker.
- OpenCode `plan` is an application policy, not an independent OS or container sandbox.
- Workspaces can be renamed and reordered from Settings; deletion is not yet supported.
- Device OAuth displays raw Codex CLI instructions; it does not yet use `codex app-server` JSON-RPC.
- Anthropic Messages currently uses the common text/tool-use path; provider-specific server tools,
  prompt-caching controls and extended-thinking options are not exposed.
- Remote MCP supports Streamable HTTP, environment-backed headers, and separate startup, catalog,
  and execution timeouts, but not interactive OAuth. MCP prompts, resources, and resource templates
  are not exposed to the model.
- Custom tool modules are trusted local code loaded into the server process; TypeScript modules must
  use syntax supported directly by Node 24.
- Custom-tool `metadata()` and nested `ask()` calls are compatibility no-ops after the tool-level
  access check; rich custom-tool attachments are not yet indexed as thread artifacts.
- Exact edit does not yet include OpenCode's fuzzy replacement fallbacks, formatter integration, or
  file diagnostics. Binary/image/PDF reads do not produce tool-result attachments.
- Skill discovery supports local `SKILL.md` trees but not remote catalogs or flat Markdown skills.
- Codex and OpenCode CLI JSON modes do not expose every answer token. Nexestra streams every
  lifecycle record they emit, while custom OpenAI-compatible providers provide token-level text.
  Thinking shows only reasoning or summaries explicitly emitted by a runtime; hidden model
  chain-of-thought is unavailable.
- Queues live in process. A restart marks runs interrupted; the user can click Retry from the
  conversation controls or the corresponding Run history row.
- Markdown code blocks do not yet have syntax highlighting, and web links are not unfurled.
- Artifact deletion, nested replies, reactions, and multi-user authentication are not supported.
- Transcripts use one file per thread, not one file for the entire workspace; this boundary reduces
  contention while preserving one shared source of context for every participant in the thread.
