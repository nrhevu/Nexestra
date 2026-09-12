# Nexestra

Nexestra is a local-first workspace where people can chat and work with coding agents.
Milestone M9 is a fresh rebuild focused on two primary workflows:

- create **Worker agents** powered by Codex or OpenCode;
- create **Master agents** using ChatGPT OAuth through Codex CLI or an OpenAI-compatible or Anthropic Messages endpoint;
- chat in shared threads and invoke agents only with an `@handle`;
- save shared documents and Git repositories, then reference them with a `#handle`;
- attach files and images, and browse each thread's indexed files and links;
- manage planned work, repository knowledge, and agents in Taskboard, Knowledge, and Agents;
  keep a bounded Markdown plan in the workspace Whiteboard.

Workspaces are selected from the far-left rail. Each workspace has its own threads, agents, and
tasks; Threads, Surfaces, and Settings live in the navigation panel beside that rail. Creating a
workspace also creates its initial `general` thread.
The workspace rail shows compact counts for active runs and attention items in other workspaces;
those counts refresh with normal bootstrap revalidation or an explicit refresh and expose no details.
While any badge is nonzero, the browser refreshes these counts every five seconds; idle workspaces
are not polled.
Settings can rename any workspace and reorder the rail. The order is saved in `state.json` and
restored after a restart.

Choose **Export selected workspace** in Settings or use `/export workspace`, then **Download ZIP**,
to export workspace metadata, active and archived conversations, uploaded files and retained
document versions. The ZIP includes a manifest with file sizes and SHA-256 hashes. Credentials,
harness login files, repository/worktree files, browser drafts and unreferenced files are excluded.
Known credentials are redacted from structured text; an original upload or document containing a
literal known credential blocks the export. This does not detect every possible secret.
Exports are limited to 128 MiB of source data and fail visibly if included files are missing or
change during preparation. **Cancel export** stops a pending request; changing workspace also
cancels it. Import and restore are not supported. See
[the export design and limits](docs/adr/0046-portable-workspace-export.md).

Choose **Inspect workspace ZIP** in Settings or `/inspect workspace zip` to check a saved Nexestra
export. Select a ZIP and click **Check ZIP** to verify its manifest, file sizes, CRC and SHA-256
hashes. The file stays in your browser; the report names the workspace inside that archive and lists
its payloads. Cancel or close to stop checking. Only Nexestra's stored ZIP v1 profile is supported;
recompressed or encrypted archives are unsupported. A matching manifest does not prove authenticity,
completeness or the ability to restore the data. When opened from a workspace, the inspector also
warns if the archive's manifest belongs to a different workspace; the workspace ID is authoritative
and the display name is informational. After verification, **Plan restore** shows a bounded,
read-only inventory and explicit blockers. It does not check a restore target or change local data;
import, merge conflict handling and rollback remain unsupported. See
[the inspection design](docs/adr/0047-local-workspace-archive-inspection.md).

Both archive dialogs load when opened. Close or press Escape while loading; if loading fails or
takes more than 15 seconds, **Retry loading** tries again. Opening the dialog starts no export or
ZIP check. Closing keeps your current draft and selected message attachments. Persistent loading
errors may require reopening the page and reselecting attachments; the app does not reload
automatically. See
[the loading design](docs/adr/0048-deferred-workspace-archive-dialogs.md).

**Needs attention** gathers agents waiting for your answer or approval and tasks that are blocked,
failed, or interrupted. Open an item to return to its thread or task process controls. Thread rows
show current agent activity, including work in other threads while your current conversation runs.
Items disappear when the underlying condition is resolved; this view does not start or approve work.

Open **Run history** under Surfaces, or use `/runs` or `/run history`, to find earlier agent runs
across the current workspace. Filter by status, agent or conversation, including archived threads.
The **Cost filter** can narrow the list to observed runs above their agent's configured per-run
limit; runs without enough usage or pricing data remain unknown and are omitted from that view.
**Older runs** and **Newer runs** replace the current 50-row page. **Open run** returns to the message
that started it and keeps your drafts and selected files. Use **Refresh run history** or the global
**Refresh** to update statuses and return to the newest page; leaving the surface resets its filters.
Returning to the app also refreshes this list from the newest page with the current filters.
If some conversations cannot be read, the list shows that its coverage is incomplete.
Failed and interrupted rows also expose **Retry run**. Select several visible failed or interrupted
rows and choose **Retry selected** to queue them sequentially. Each retry uses the server's
stale-attempt and archived-thread checks, then refreshes the list after a new attempt is queued.
Rows with failures show a safe kind such as **Timed out**, **Verification failed**, or **Provider
error**; open the conversation for the bounded, redacted details.
Delegated Worker rows also show their redacted Taskboard title when the assignment can be matched;
ordinary or legacy runs omit task context.
Terminal runs also show their elapsed wall-clock duration, helping compare slow runs and harnesses;
queued and active runs omit this value until they finish.
When a custom OpenAI-compatible provider reports usage, run history also shows its total input and
output token count. Missing or partial provider usage is left blank; these counts are estimates from
the provider and are not billing records. The surface also summarizes matching run count, terminal
time, token total, usage coverage, and explicit helpful/needs-work ratings above the paged rows.
When every matching run has usage and pricing coverage and at least one helpful rating, it also
shows an estimated cost per helpful reply; incomplete coverage leaves that comparison blank.
Agent pricing profiles can also include an optional maximum estimated cost per run. History marks
an observed estimate above that limit and counts matching over-budget runs; this is a local review
signal, not provider billing enforcement.
Per-agent rows show the same rating counts. Marking a response **needs work** opens an optional note
field so later review has context; helpful remains one click. Replies created by the harness retain the exact run ID
that produced them, so retries and delegated Worker/Master replies are compared against the right
run; older replies without that provenance are included only when their trigger has one matching
run. Ratings are user signals, not an automatic score or billing record.
**Export loaded runs** downloads a bounded `nexestra.run-history` JSON packet containing the visible
rows, active filters, pagination cursors, coverage, and the complete filtered summary. Load older
pages first when they should be included; the packet contains no transcript text or raw provider
errors. **Export CSV** downloads the same loaded rows as escaped spreadsheet columns for status,
duration, usage, cost, budget, and bounded agent labels; it also excludes transcript and raw error
text.
For cross-workspace comparisons, `GET /api/runs/summary` returns count-only aggregates with token,
estimated-cost, over-budget, and transcript-coverage fields. Supplying `workspaceId` restricts the
response to one workspace; omitting it returns one entry per workspace. The paged `/api/runs` view
and its cursors are unchanged. Run history renders this comparison when multiple workspaces are
available and keeps the local paged view usable if the comparison read fails.
Per-agent history entries also show bounded harness and model labels (`Codex`, `OpenCode`, or
`Custom`) when the current profile provides them, while provider URLs and credentials remain out of
telemetry. See [ADR 0095](docs/adr/0095-agent-profile-labels-in-history.md).
Enable **Auto-refresh newest page** when supervising active work; it checks the current filtered
first page every 15 seconds, pauses on older pages, and never retries or changes run state.

Attention actions are also available as a bounded audit trail. Open **Needs attention** and choose
**Refresh history** to load the newest 200 snooze or dismiss actions for the selected workspace;
the log contains only action metadata and timestamps, not task or transcript content. See [ADR
0096](docs/adr/0096-attention-audit-history.md).
Settings also offers optional desktop notifications for increased Attention counts. Permission is
requested only after you enable the toggle; browser storage or denied permission does not affect the
app, and notification text contains only the workspace name and count. See [ADR
0097](docs/adr/0097-opt-in-desktop-attention-notifications.md).
Custom surfaces can also include an `over_budget` card. It shows the selected workspace's complete
coverage count and opens Run history with the same cost filter; incomplete telemetry leaves the
count absent rather than presenting a misleading zero. See [ADR
0098](docs/adr/0098-over-budget-custom-surface-card.md).

Open **Needs-work review** under Surfaces, or use `/needs-work review`, to revisit the latest
negative rating for each agent reply across the workspace. The queue shows a bounded, redacted
excerpt and note, and when reply provenance includes a user trigger, its bounded redacted prompt.
It reports conversations that could not be scanned and opens the exact source message. The header
also reports the number of matching reviews across the current status filter,
before pagination. Use **Mark reviewed** to close an item without changing its rating or source;
the status filter can reopen or inspect resolved items. Promotion to Knowledge still requires the
existing review dialog and explicit capture; each queue row also offers **Capture as Knowledge**
to open that dialog directly. **Export loaded reviews** downloads a bounded JSON review-case packet
containing the visible redacted rows, prompt context, feedback note and stable message/run IDs; load
older reviews first when you need them in the packet.
The queue can also be narrowed to one workspace agent or thread; changing any filter starts a fresh
first page, and the active agent/thread selection is recorded in review-case exports.
Select open rows to mark a bounded visible batch reviewed sequentially; selection is cleared when the
page or filters change.
Use **Select all visible** for the loaded page, or clear the selection before choosing another batch.

Open **Needs attention** to review pending approvals, questions, and blocked or failed work. Each
item can be snoozed for one hour, four hours, or one day, or dismissed; snoozes expire automatically,
while dismissals return when the underlying run or task changes.
Workspace exports retain this bounded attention metadata for the selected workspace.
Knowledge document details offer an explicit **Keep latest 10 revisions** action; the current revision
is always retained and pruning never runs automatically.

Completed Worker results in Taskboard also offer **Save as Knowledge** when their canonical reply is
available. This opens the same reviewed capture dialog and preserves the Worker message's thread and
run provenance; displayed result text is never trusted as a separate source. Legacy assignments
without a matching reply keep the action hidden.

Workspaces can add a domain-specific launch surface in `nexestra.config.json`:

```json
{
  "surfaces": [
    {
      "id": "inference",
      "title": "Inference lab",
      "description": "Compare profiles, runs, and review signals.",
      "cards": [
        { "id": "profiles", "title": "Model profiles", "action": "agents" },
        { "id": "runs", "title": "Run comparison", "action": "runs" },
        { "id": "reviews", "title": "Needs-work queue", "action": "reviews" }
      ]
    }
  ]
}
```

Cards are text-only and can route only to trusted Nexestra surfaces; configuration cannot execute
browser code or open arbitrary URLs. Taskboard, Knowledge, Attention, Needs-work review, and Agents
cards show selected-workspace counts; data-backed widgets and custom forms remain future extensions.

Thread rows also show **unread messages**, with a total on Threads. Reading the bottom of the
latest Messages page in a focused window marks that loaded page read. Older pages, message links
and Files & links keep newer messages unread. Choose **Mark all conversations read** beside the
Threads list or use `/mark all read` to acknowledge the currently known counts, including archived
threads. These markers are saved in this browser and shared with its other tabs on the same local
origin. Existing history starts read on first use; the feature does not reconstruct earlier reading.

Use **All / Unread** above the list to find conversations with new messages. The filter counts
conversations and keeps the current row visible after reading. **Next unread conversation** or
`/next unread` cycles through active and archived conversations in sidebar order, opening the first
unread message. **First unread** or `/first unread` opens that point in the current conversation,
including from Files & links. The resulting message link remains stable through Refresh and reload;
opening it keeps the unread count until you explicitly **Mark read** (`/mark read`) or read the bottom
after choosing **Show latest**. Mark read acknowledges only this conversation, using its latest known
count, and leaves the current page in place. If the saved point is unavailable, recent messages appear
with a notice and keep their read state.
The filter stays per workspace in this tab and resets to All after reload.

Returning to the workspace refreshes its metadata and the conversation page you were reading.
You can also choose **Refresh** beside search or the `/refresh workspace` command. Drafts and
selected files stay in place, including an unconfirmed send. A failed refresh offers **Retry**;
refreshing does not send messages or approve agent work.

Press **Cmd/Ctrl+K** to focus search, use **↑/↓** to select a result, **Enter** to open it, and
**Escape** to dismiss suggestions. Task and knowledge results open the exact item. Start a query
with `/` to find commands, including opening Needs attention.

Choose **Messages** beside search, or the `/search messages` command, to find a remembered phrase
in the current workspace's transcripts. Narrow by thread or active/archived status. Results show a
snippet, author, time, and the current thread name; selecting one opens and focuses that message.
The message URL survives reloads and thread renames. **Show latest** returns to the newest messages.
Search is case-insensitive literal text; partial results are labeled when the scan cannot finish.

Each saved message has a **Copy message link** action beside its timestamp, including in archived
threads and on older pages. If clipboard access fails, a field shows the URL for manual copying.
These links open the same local server and data; they do not publish the conversation.

Messages opens the newest 50 messages. **Older messages** and **Newer messages** replace that page;
**Show latest** returns to the newest page. Message links load the page around the selected message.
An old page keeps its position while run and tool state updates. Needs attention opens the exact
message for a pending decision, including one outside the newest page. **Files & links** loads the
complete inventory when opened, so files shared earlier remain available with their attribution.

Conversation controls wrap on narrow screens. On short screens, the header can scroll so the
transcript and composer remain usable. Focus a code block, table or display formula to scroll it
with the arrow keys; long prose and URLs wrap. Long link labels may end in an ellipsis, while the
complete URL and original message remain saved (within the existing 4096-character URL limit).

Composer drafts are stored per workspace and thread, so switching threads or reloading the tab
restores what you were typing. Thread rows show a **Draft** badge while a draft exists, and the
Threads entry returns to the last thread you had open in that workspace. Drafts stay browser-only;
if browser storage is unavailable they remain in the tab with a short note.
Selected files also stay per conversation while switching threads, surfaces or workspaces in the
same tab. Their bytes remain in memory; after reloading or closing the tab, select the files again.

If a send fails before its result is confirmed, sending the unchanged draft again confirms the
original message. It preserves the original attachments and agent runs, including runs that have
already finished. Editing an in-session payload or deliberately sending after a successful send starts
a new message. Pending text sends can be recovered after a reload; attached files must be selected
again because the browser does not persist their bytes. An explicit new send remains available if
you want to replace an unconfirmed attachment submission.

API clients can supply a random UUID `requestId` with JSON or multipart sends. The first successful
creation returns 201; confirmation of a saved request returns 200 and `replayed: true`. Reusing a
thread's request ID with different content or ordered attachments returns 409. Clients that omit
the ID retain ordinary independent-send behavior. Confirmation and an explicit agent **Retry** are
separate actions.

Thread headers offer **Rename**, **Archive**, and **Restore**. Archiving keeps the transcript,
attachments, draft, and links in the sidebar's **Archived** list, with a read-only conversation view.
Restore the thread to send messages or retry/delegate work. Archive is refused while messages or
agent work are pending, and ordinary workspace navigation selects an active thread.

## Run locally

Requires Node.js 24+ and pnpm 11.

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. The backend binds only to loopback on port `4242`.
Change the port with `NEXESTRA_PORT`.

By default, data is stored in `.nexestra/` in the running repository:

```text
.nexestra/
├── state.json          # workspace, agent, thread, task, knowledge, and assignment metadata
├── credentials.json    # custom API keys, mode 0600
├── artifacts/
│   └── <thread-id>/<artifact-id> # uploaded bytes, mode 0600
├── workspaces/
│   └── <workspace-id>/
│       ├── knowledge/<knowledge-id>/revisions/<revision-id> # immutable document versions
│       ├── repositories/<knowledge-id>/source
│       └── worktrees/<assignment-id>
└── threads/
    └── <thread-id>.jsonl  # the thread's shared append-only transcript
```

Set `NEXESTRA_HOME=/another/path` to keep data outside the repository.

## Invoking agents

Messages without a mention are only saved to the transcript. A message containing `@maya`,
`@codex`, or multiple handles creates one run for each invoked agent. Agent replies are recorded
in the same transcript file. Agent replies do not trigger other agents, which prevents loops.
Transient run failures receive at most two automatic retries; every attempt remains visible in the
canonical thread history.

Messages render as safe GitHub Flavored Markdown with headings, emphasis, lists, task lists, tables,
quotes, links, inline code, fenced code blocks, and KaTeX math. Raw HTML is shown as text instead of
executed, unsafe link schemes are disabled, and external HTTP(S) links open in a new tab. The exact
Markdown source remains unchanged in the shared transcript and agent context.

While an agent is active, the thread receives a live event stream with its current phase, tool
activity, runtime-emitted reasoning, and in-progress answer. Reasoning is collapsed behind a
**Thinking** disclosure. Custom OpenAI-compatible and Anthropic Messages providers stream response
deltas through their native SSE protocols; OpenAI-compatible providers may also emit reasoning
deltas. Codex and OpenCode stream the JSONL lifecycle events their CLIs
expose. When a run completes successfully, transient thinking and tool activity disappear so the
thread shows only the final answer. Durable tool records remain in the canonical transcript for
recovery and audit; transient reasoning and text deltas are never persisted as chat messages.
Use **Stop** beside an active ordinary agent run to abort its local provider or CLI request. The
run remains as an interrupted history row and can be retried explicitly; delegated Worker
assignments continue to use Taskboard's process controls.

The composer accepts up to 10 files per message, with a 20 MB per-file and 50 MB combined limit.
Safe raster images render inline; other files download rather than execute in the browser. Every
thread has a **Files & links** view with search and type filters. Nexestra automatically indexes
HTTP(S) links in user and agent messages, plus existing workspace files referenced by Markdown
links or inline-code paths. Uploaded files remain immutable; workspace-file references always open
the current file contents.

Artifacts on the triggering message are passed to the invoked agent. Codex receives image inputs,
OpenCode receives file inputs, and custom providers receive bounded text-file content and safe
raster images in their native multimodal request shape.

The **Knowledge** surface stores workspace-scoped documents and Git repositories. Typing `#` in
the composer opens the knowledge picker. Text documents are included as bounded context; binary
documents are exposed by their managed local path. Repository URLs may use HTTPS or SSH, and local
Git paths are also accepted. URLs containing embedded credentials are rejected. Click a Knowledge
card to inspect its details, edit its name, `#handle`, and description, download a stored document,
or permanently delete it. A repository whose clone failed can be retried from its detail dialog with
**Retry clone**; the record keeps its id, `#handle`, source, and creation time while the clone is
re-created safely. A ready repository offers **Change branch** to choose an existing source branch
for future Worker assignments. Open the picker to load branches, choose or type a name, and apply
the change. **Refresh source** fetches the selected branch, or the original default branch before
the first selection. The detail view shows the branch, selected commit and refresh time. Existing
Worker worktrees and edits stay intact; a failed fetch keeps the previous starting point usable.
A stale picker requires reloading before applying a choice, preserving a newer selection made in
another window. A partial branch list allows typing an existing branch name directly.
Documents offer **Replace file** and **Version history**. Download an older version or restore it as
a new current version while keeping the item's identity. New messages pin the version referenced at
send time, including the first new reference to an older stored document. A stale replacement or
restore is rejected so another window's edit is preserved. Permanent Knowledge deletion removes its
versions; changing a repository source still uses delete-and-create.
Use **Preview current** or a version's **Preview** button to read document text before downloading
or restoring it. The preview shows up to the first 128 KiB of source text, verifies stored revision
checksums and provides a download for that version. Text remains plain text, including Markdown
and HTML; unsupported files have a download fallback. Previewing does not create or change versions.

The **Whiteboard** surface is a small workspace-scoped Markdown scratchpad for plans and decisions.
It is saved under managed local storage, redacts configured credentials before persistence and
response, and accepts at most 64 KiB of UTF-8 text. It has no agent execution or arbitrary markup
hooks. Saved notes are included in workspace ZIP exports as a redacted `whiteboard.md` entry.

Use **Save message as Knowledge** beside any message to open a review dialog. Inspect the unchanged
source, choose a name, `#handle`, and optional description, then confirm the capture. API clients
can call `POST /api/knowledge/from-message` with `threadId`, `messageId`, `name`, `handle`, and
optional `description`/`workspaceId`. The immutable Markdown document retains source IDs and redacts
known credentials. Capture does not summarize or verify the message; editing the resulting document
is still an explicit follow-up.

Workers run in read-only discussion mode. For an implementation request, a custom-provider Master
must call `plan` to create durable Taskboard tasks and then call `delegate` for each task it assigns.
If the provider tries to return a final answer while planned tasks are still undelegated, the
harness sends it back to the tool loop instead of leaving silent, unassigned work on the board.
Delegation creates `nexestra/<assignment-id>` from the selected `#repository` and checks it out into
an isolated managed worktree. The Worker runs there with write access, verifies its work, and
commits on that branch. Nexestra does not merge or push the branch automatically.

Each task can also carry a user-defined verification command. After the Worker finishes, Nexestra
runs that command in the same worktree. Exit code 0 moves the task to Done; any other exit code
moves it to Blocked and records the command output. The command is a user-owned contract, so the
Master `plan` tool cannot invent or change it.

Every assignment is also a durable Worker run. Click any Taskboard card to inspect its assignee,
repository, verification result, isolated branch and worktree, current phase, live reasoning,
streamed response, and tool calls. Completed cards retain the Worker result and verification output
in this process view. A finished worktree can be removed explicitly; Git refuses dirty or untracked
work, while the branch and run history remain. A blocked, failed, or interrupted assignment can be
retried with the same Worker and repository. An unstarted task can be delegated from its process
dialog by selecting an enabled Worker and ready repository. The process also lists every
assignment attempt with its branch, status, verification exit code, and worktree cleanup state. A
merged assignment branch can be deleted after its worktree is removed; Git refuses unmerged
branches. A
task that was never delegated says so explicitly. The same detail view can edit every task field or
permanently delete the task when no Worker assignment is active. While an assignment is queued or
  running, **Stop process** terminates its Codex/OpenCode process group, records the run and unfinished
  tools as interrupted, and returns the task to To do so it can be delegated again.

The process dialog can also render a read-only Git review snapshot on demand: the starting commit
captured when the worktree was prepared, committed and dirty tracked changes, a bounded unified
diff, and untracked files. Refresh takes a fresh snapshot; the review never merges, applies,
resets, or cleans up.

Manual delegation saves a user request with the selected Worker's mention before queuing work.
The process dialog opens the queued assignment immediately, streams its progress, and keeps Stop
available while it runs. Manual and Master assignments share the Worker's serial queue, including
verification; other Workers can proceed independently. Failed preparations and Worker calls retain
their run and tool history so the task can be retried.

Custom-provider Master agents have a provider-neutral
harness with `list`, `glob`, `grep`, `read`, `edit`, `write`, `bash`, `apply_patch`, `skill`,
`plan`, `delegate`, `todowrite`, `webfetch`, `websearch`, and `question`. LSP is intentionally not
included. Questions
pause in the thread until the user answers; approval-gated tools pause until the user allows or
denies the call.

Custom providers may use OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. The
Anthropic adapter uses the `/messages` endpoint and `x-api-key` credential header, and supports
the same bounded built-in, custom and MCP tool loop. Provider-specific server tools, prompt
caching controls and extended-thinking options remain disabled until they have explicit permission
and cost models.

Each Master has one access mode instead of separate settings for every tool:

- **Ask for permission:** reads, skills, todos, and questions run directly; edits, shell commands,
  web access, and extensions pause for approval.
- **Auto:** built-in tools run automatically inside the normal harness boundaries; custom and MCP
  tools still pause for approval.
- **Full access:** every tool runs without approval. Fixed credential, path, network, timeout, and
  output protections still apply to the provider-neutral harness.

## Master harness configuration

Optional workspace configuration lives in `nexestra.config.json`. It can tighten the selected
access mode, add search ignores, choose the hosted web-search backend, add custom tool directories,
and configure local or remote MCP servers. Wildcards apply to normalized custom and MCP names; an
MCP tool named `lookup` on server `docs` is exposed as `docs_lookup`. Configuration can make an
access policy stricter, but cannot silently loosen it. Permission rules use OpenCode's ordered
matching semantics: when multiple patterns match, the last matching rule wins.

```json
{
  "permission": {
    "deploy_*": "deny",
    "docs_*": "ask"
  },
  "ignore": ["generated/**", "coverage/**"],
  "websearch": { "provider": "exa" },
  "customTools": { "directories": ["tools/nexestra"] },
  "mcp": {
    "timeout": { "startup": 30000, "catalog": 30000, "execution": 43200000 },
    "servers": {
      "localdocs": {
        "type": "local",
        "command": ["node", "tools/docs-server.mjs"],
        "environment": { "DOCS_TOKEN": "{env:DOCS_TOKEN}" },
        "timeout": 30000
      },
      "remote": {
        "type": "remote",
        "url": "https://mcp.example.com/service",
        "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" }
      }
    }
  }
}
```

Repository custom tools are discovered in `.opencode/tool/`, `.opencode/tools/`,
`.nexestra/tool/`, and `.nexestra/tools/`; user tools are also discovered in the OpenCode config
directory. A `.js`, `.mjs`, `.cjs`, or Node-compatible `.ts` module may use the official
`@opencode-ai/plugin` helper or export an equivalent object. Raw Zod `args` shapes and JSON Schema
`parameters` are accepted. Default exports use the filename as their tool name; named exports use
`<filename>_<export>`. The execution context includes OpenCode-compatible `sessionID`, `messageID`,
`agent`, `directory`, `worktree`, `abort`, `metadata`, and `ask` members.

```js
// .opencode/tool/greet.mjs
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Greet a person.",
  args: {
    name: tool.schema.string()
  },
  async execute(args) {
    return `Hello ${args.name}`;
  }
});
```

`glob`, `grep`, and `list` respect `.gitignore`, `.ignore`, and configured ignore patterns while
always excluding Nexestra data and credential files. `webfetch` blocks private-network targets,
validates redirects, and caps responses. `websearch` uses Exa by default or Parallel when selected;
their optional `EXA_API_KEY` or `PARALLEL_API_KEY` environment variables are supported. The file
tools accept OpenCode's `filePath`, `oldString`, `newString`, `replaceAll`, and shell `workdir`
arguments while retaining legacy Nexestra aliases. Oversized tool output is previewed and the full
redacted result is saved under `.nexestra/runs/tool-output/` for continuation with `read`.

## Agent lifecycle

Disabling an agent removes it from the mention picker without deleting its configuration. Archiving
also keeps the profile and any saved credential, and archived agents remain available in the Agent
management surface for permanent deletion. Deleting an idle agent removes its profile and saved
credential, unassigns its current tasks, and releases its handle for reuse. Shared thread history is
append-only, so existing messages remain attributed to the deleted agent. Agents with queued or
running work cannot be deleted until that work finishes.

When creating a Worker, the model and reasoning effort are optional. Leaving either field blank
uses the selected harness default. Codex receives the model and `model_reasoning_effort` overrides;
OpenCode receives `--model` (in `provider/model` form) and the provider-specific `--variant`.

Every agent profile can be edited from the Agent management surface: name, handle, description,
custom instructions, and the Worker or Master fields shown at creation. Handles stay unique per
workspace and can be reused after an update, while kind, workspace, and ID remain fixed. Clearing a
Worker model or reasoning effort removes the override and returns to the harness default.

Custom Master API keys are write-only. The edit form never reveals a stored key: leaving the key
field blank keeps it, entering a new key rotates it in the same save, and a separate checkbox
removes it explicitly. Configuration edits are blocked while the agent is busy, queued, or being
changed, so a running agent never reads a half-applied profile.

## Provider

- **ChatGPT OAuth:** install Codex CLI and run `codex login`, or click Connect in the Master
  creation form. Ask mode is read-only, Auto uses Codex's workspace-write sandbox and automatic
  approval review, and Full access bypasses the Codex sandbox and approvals. Codex CLI manages
  OAuth tokens; Nexestra never reads or stores them.
- **Custom:** enter an API root and model, then select OpenAI Chat Completions or OpenAI Responses.
  The API key may be left blank for a local endpoint; a non-empty key must contain at least eight
  characters. Remote endpoints must use HTTPS; HTTP is accepted only on loopback. Select one access
  mode for the entire agent. Shell, custom tools, and local MCP servers run as the current local OS
  user, so use Full access only when the provider and extension code are trusted.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# or run everything:
pnpm check
```

Default tests do not call paid providers and do not require a Codex or OpenCode account.

See the [architecture](docs/ARCHITECTURE.md) and [current limitations](docs/ARCHITECTURE.md#known-gaps).
