# Architecture — Milestone M9 fresh rebuild

## Product boundary

M9 is a single-user, local-first control center. The server binds to `127.0.0.1`, the SPA
communicates over HTTP, and the server invokes configured coding harnesses or providers. The two
primary navigation areas are Threads and Surfaces; the initial surfaces are Taskboard, Knowledge,
and Agents.
Work Briefs adds shared scope for research, documents, design and code without requiring a repository.
Goals adds bounded, review-driven continuation (ADR 0021). Custom surfaces adds four declarative host
renderers and shared human/Master commands (ADR 0020).
The far-left rail switches between workspaces, while the adjacent panel owns the Threads, Surfaces,
and Settings navigation.

## Components

```text
React SPA
   │ HTTP + thread SSE
   ▼
Hono API ── FileStore ── state.json / credentials.json
   │                    ├─ threads/<id>.jsonl
   │                    ├─ artifacts/<thread-id>/<artifact-id>
   │                    └─ workspaces/<id>/{knowledge,repositories,worktrees}
   ▼
ChatService ── AgentDispatcher ── LocalAgentRunner
                                  ├─ codex exec --json (discussion / delegated task / full)
                                  ├─ opencode run --format json (plan / build)
                                  └─ MasterHarness ── OpenAI-compatible HTTP
                                                   ├─ built-in tools + user questions
                                                   ├─ durable plan + Worker delegation
                                                   ├─ workspace/user custom tools
                                                   └─ local/remote MCP servers
```

The shared Zod contracts in `src/shared/contracts.ts` define the boundary between browser and server.

The [target harness design](HARNESS-DESIGN.md) and [surface extension contract](SURFACE-EXTENSIONS.md)
describe planned layers; they are not claims about the current implementation.

## Shared scope and surface catalog

Each thread may have a Work Brief with outcome, deliverables, constraints, non-goals, open questions
and paired behavior/check descriptions. Its revisions are `brief.updated` events in that thread's
canonical JSONL. The latest event is replayed into an in-memory index during startup, avoiding full
transcript scans on each bootstrap. No second canonical brief exists in `state.json`.

Store writes require an expected revision and use the existing serialized write queue. Content is
bounded and redacted before append/fsync. User and dispatcher-bound agent drafts are attributed by
the server; input cannot supply status or authorship. Every edit returns to draft. Optional user
confirmation requires an outcome, output and check, with no open questions; it records scope
agreement only. Neither operation invokes an agent or changes its permissions.

The HTTP API and Master `read_brief`/`draft_brief` tools share the same store operations. The
dispatcher pins the current brief in each invocation, and both CLI adapters and HTTP protocols
include it in their prompts. Agent tool edits notify the existing thread event stream. Brief events
are not rendered as duplicate chat messages and do not change message counts.

Built-in surface metadata lives in `src/web/surfaces/registry.ts` and feeds routes, sidebar entries
and command search. Work Briefs has its own component and stylesheet; existing renderers remain
explicitly composed in App. Declarative definitions can be imported or written by the Master;
there is no executable external UI plugin loader. See [extensions](SURFACE-EXTENSIONS.md).

Thread-scoped Goals freeze task contracts and the available Work Brief, then use atomic attempt
admission and human review events to continue. The original deadline survives pause/restart;
active work is paused on recovery, without replay. Goal controls are user-owned. See [Goals](GOALS.md).

## Refresh and rendering model

The SPA performs no periodic requests while the selected workspace is idle. The Goals surface polls
checkpoints while a goal is active or awaiting review. While the visible
thread has queued, running, approval-waiting, or input-waiting work, it opens one Server-Sent Events
connection. The dispatcher publishes phase changes, runtime-emitted reasoning, and accumulated
response text directly, and marks events that require the browser to reload durable messages, runs,
or tools. Browsers without
EventSource retain the one-second active-thread polling fallback. If work continues after the user
navigates elsewhere, a lightweight activity endpoint is polled instead; the full workspace
bootstrap is refreshed once when activity finishes. The dispatcher keeps the live run and response
projection in memory, while JSONL run and tool events remain the durable source used for restart
recovery.

Harness installation and ChatGPT login status are cached for 30 seconds and explicitly invalidated
by the login flow. In React, search input owns its local state and the transcript is a memoized render
boundary. Runs are grouped by trigger in one pass, so typing does not rebuild message rows and a
transcript refresh does not perform a messages-by-runs nested scan.

Message content is stored and transported as unchanged Markdown. The browser renders it with
GitHub Flavored Markdown and KaTeX inside the memoized transcript boundary. Raw HTML parsing is not
enabled, the Markdown renderer removes unsafe URL schemes, and HTTP(S) links use isolated tabs.
Agent and knowledge-reference highlighting is applied to rendered text nodes while links and code
remain untouched.

## Persistence

`state.json` stores workspaces, agent profiles, thread metadata, tasks, knowledge metadata, and
Worker assignments. Every record carries a workspace ID. Handles and thread slugs are unique only
within their workspace, and task references cannot cross workspace boundaries. Creating a
workspace seeds a `general` thread.
Version 1 state is migrated in place to version 2 by assigning every existing record to a default
`Nexestra` workspace; record IDs and transcript paths do not change. Version 2 state migrates to
version 3 by adding the first Master tool permissions; version 3 migrates to version 4 by adding the
complete tool matrix. Version 4 migrates to version 5 by replacing that matrix with one `ask`,
`auto`, or `full` access mode. Version 5 migrates to version 6 by adding empty knowledge and
assignment collections. State writes use a temporary file followed by an atomic rename. The
separate `credentials.json` file has mode `0600` and stores only custom API keys by agent ID.

Permanent agent deletion removes the profile and its custom credential, clears matching task
assignments, and releases the handle for reuse. Credential removal is persisted before public state
so an interrupted multi-file write favors removing the secret. Thread JSONL files are never rewritten
for agent deletion; historical author and mention snapshots remain part of the canonical transcript.

Task and Knowledge metadata support create, detail, update, and permanent-delete operations.
Deleting a task is rejected while one of its Worker assignments is queued or running. Historical
assignment and transcript events are retained after task deletion. Deleting repository knowledge is
also rejected while cloning or while a related assignment is active. Unused Knowledge storage is
removed; repository storage with assignment history is retained so its worktrees remain inspectable.
Existing message text and stable historical references are never rewritten.

Each thread has one canonical JSONL file. The `message.created`, `artifact.created`, `run.updated`,
and `tool.updated` events use a monotonically increasing sequence. Artifact metadata and message
IDs are committed in the same append; uploaded bytes live under a thread-scoped private directory.
User messages are appended and fsynced before agents are queued. Read projections select messages
and artifacts by sequence and the final state of each run. On startup, only an incomplete JSONL tail
is truncated. After a restart, queued, running, approval-waiting, or input-waiting runs are completed
if their replies were fsynced; otherwise, they and any unfinished tools are marked interrupted and
can be retried.

The upload boundary validates file count and size before converting multipart files to byte buffers.
Images are classified from a small MIME allowlist; SVG and every other file type are downloaded with
`nosniff`. HTTP(S) URLs are indexed from both user and agent messages. Markdown links and inline-code
paths are indexed only when they resolve through a real path to a regular file inside the workspace;
app data and Git internals are excluded. The content endpoint repeats that containment check so a
changed symlink cannot escape the workspace.

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

## Planning and Worker delegation

The provider-neutral Master tool session owns a per-run set of planned task IDs. `plan` creates
durable Taskboard tasks linked to the triggering thread. `read_tasks` discovers existing eligible tasks. `delegate` accepts a task returned by either
tool in that session and an enabled Worker; repository-backed work also needs a ready repository. The runtime
lists those repositories in the Master context, so the triggering message does not need to include
the repository handle. When a Worker is available, a custom-provider
Master cannot return its final answer while that set still contains undelegated tasks; the runtime
adds a corrective turn and keeps the tool loop active.

Each repository is cloned once under the owning workspace. Every repository assignment creates a unique
`nexestra/<assignment-id>` branch and a Git worktree under the same managed workspace tree. The
dispatcher reuses the normal per-agent queue, so one Worker remains serial while different Workers
can execute concurrently. A delegated Worker receives task mode, the worktree as its process cwd,
the shared transcript snapshot, and the selected repository as knowledge. Success completes the
assignment and submits the task for review; failure records a redacted error and returns it to To do.
Branches and worktrees are retained for inspection. Nexestra never merges or pushes.

Each delegated assignment owns an in-memory abort controller from before it is queued until its
final cleanup. Stopping a task aborts both Git worktree preparation and the Worker harness process;
CLI harnesses forward the signal to the detached process group and escalate from TERM to KILL after
the normal grace period. The assignment, run, and unfinished tool calls become `interrupted`, while
the task returns to To do and is unassigned. A stop request also repairs stale queued/running state
left without an in-memory controller after a restart.

The assignment ID is also the delegated Worker's durable run ID in the canonical thread JSONL.
Native Worker tool events are normalized and persisted against that run, while reasoning and
partial text remain in the dispatcher's bounded live projection. The Taskboard process endpoint
joins task, assignment, run, tool history, and current live activity. Its dialog subscribes to the
same thread SSE stream as chat, with an active-only polling fallback when EventSource is unavailable.

## Agent runtimes

Revision assignments pin a host-selected `inputSource` (assignment/review/contract revision and
output manifest). Source files are verified with bounded descriptor reads before invocation and
copied into the new assignment's `inputs/` directory. Both CLI adapters receive these files plus
review observations; new deliverables belong in `outputs/`. A failed retry does not hide the last
changes-requested source. The same bounded manifest verification is used for human acceptance.
See [ADR 0023](adr/0023-reviewed-revision-inputs.md) for changed-scope and repository limits.

Tasks created with `sourceBriefRevision` retain a host-validated complete source brief in their
contract. These assignments use the saved source as brief context; otherwise goal/current-thread
brief lookup applies. Current task requirements take precedence over source context, and the goal
objective remains explicit. Non-Git TASK.md includes the pinned brief as well as acceptance criteria.
See [ADR 0024](adr/0024-tasks-from-saved-briefs.md) for the editable UI handoff and divergence policy.

Invocations receive a bounded 48,000-character recent transcript with marked omissions, plus
separate trigger/brief/task context. Canonical JSONL and full exports remain unchanged. The
host-scoped `read_history` tool retrieves older messages through bounded search, pages and complete
chunks; CLI harnesses also receive the transcript path. Before every custom HTTP request, a
240,000-character guard counts text, tool schemas and accumulated results. This stops oversized
requests with recovery instructions; it does not estimate tokens. See
[conversation context](CONVERSATION-CONTEXT.md) for exact bounds and known gaps.

Worker profiles select either `codex` or `opencode`, with optional model and reasoning-effort
overrides. Worker chat turns require read-only discussion mode. Delegated task turns use
workspace-write for Codex and OpenCode's build agent, scoped to the assignment worktree or general working directory. Codex maps the overrides to
`--model` and `model_reasoning_effort`; OpenCode maps them to `--model` and its provider-specific
`--variant`. Missing overrides preserve the harness defaults. Master profiles select one of the
following:

- ChatGPT: maps Ask to Codex read-only, Auto to workspace-write with automatic approval review,
  and Full access to Codex's explicit sandbox-and-approval bypass; device-login output remains in
  memory, and tokens never enter the app.
- Custom: uses OpenAI Chat Completions or Responses with an API root, model, optional API key, and
  the provider-neutral Master tool loop.

Codex receives safe raster images through `--image`; OpenCode receives each local artifact through
`--file`. Custom providers receive safe raster images as data URLs in the selected OpenAI protocol
shape and up to 512 KB of attached text context before the combined request guard. Image provider payloads are capped at 10 MB; larger
artifacts remain indexed but are represented only by metadata.

The Master tool registry provides repository list, glob, grep, read, exact edit, file write,
multi-file patch, bounded shell, skill loading, per-run todos, bounded public web fetch/search,
interactive questions, durable planning, and Worker delegation. LSP is deliberately excluded. Each profile selects one access mode. Ask
allows contextual tools directly and pauses edits, shell, web, and extensions. Auto allows all
built-ins and pauses custom or MCP tools. Full access removes tool approval prompts. An asked tool
is written to the thread and pauses its run until the user decides; a question pauses in a distinct
input state until the local user responds. Multiple calls from one model step execute concurrently,
and a run stays paused until all outstanding approvals or questions are resolved. File tools accept
relative paths and absolute paths inside the repository, reject traversal and escaping symlinks,
and protect Nexestra data and credentials. `read` also accepts exact absolute paths allowlisted from
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

Custom Chat Completions and Responses requests use their SSE streaming protocols. Reasoning and
text deltas update the in-memory run projection and are replaced by one final agent message after
completion. Responses requests ask for an automatic reasoning summary and parse both official
reasoning-summary and reasoning-text deltas; compatible Chat Completions providers may expose
reasoning through `reasoning_content` or `reasoning`. Codex
`exec --json` and OpenCode `run --format json --thinking` stdout is parsed incrementally, including
records split across process chunks. Native CLI tool events are normalized into the same durable
`tool.updated` history used by the provider-neutral Master. Reasoning content is redacted, bounded,
and kept only in the process-local run projection. The UI presents it in a collapsed disclosure
while the run is active. After successful completion, the run row—including thinking and tool
cards—is hidden and only the durable final agent message remains visible.

Harness and shell child processes close stdin, enforce timeouts and output caps, kill the process group, and inherit
only allowlisted environment variables to reduce the risk of exposing server secrets. A timeout
sends TERM, then KILL after a grace period, and reports an error only after the process exits.
Local MCP is the deliberate exception: its stdio transport owns stdin for JSON-RPC and is closed
with the per-run tool session.

## General work assignments and captured outputs

ADR 0019 extends repository delegation with managed directories for research, document, design
and mixed tasks. Manual Taskboard starts persist user mentions and return a queued run immediately;
Master and manual work share queues, cancellation and durable activity. Code tasks still require
repositories. `read_tasks` supplies durable task and review state across fresh Master sessions.

Non-Git outputs are captured into the canonical Worker reply as generated artifacts, with bounded
file counts, sizes and traversal. The assignment and human review record a digest manifest. Review
rejects changed snapshot bytes. Task detail and chat both expose the captured files; no executable
HTML from a Worker is hosted in the trusted app origin. Working directories are retained.

## Execution provenance

`GET /api/tasks/:id/process?assignmentId=...` inspects a task-scoped historical attempt. The response
includes lightweight attempt summaries and an isLatestAttempt flag. Canonical admission order
identifies the latest attempt, including tied/backward timestamps. Historical UI uses the frozen
contract and existing reviews, with mutation/launch/new-review controls hidden. Current server
admission/review checks are unchanged. See [ADR 0026](adr/0026-inspectable-task-attempts.md).

New assignment records retain the invoked Worker's configured name/handle/harness/model/reasoning
settings, an instruction fingerprint and admission timestamp. The process UI uses this snapshot
after profile deletion or handle reuse. Null overrides mean runtime default; the app does not claim
to know the actual provider-served model. See [ADR 0025](adr/0025-assignment-execution-profiles.md).

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

- Worker success moves a task to In review. Human acceptance requires evidence against its frozen
  task contract (ADR 0018). Non-Git outputs are captured with hashes (ADR 0019); executable checks
  and repository diff/commit manifests are not yet implemented.
- Work Briefs and Goals are thread-scoped. Durable goals, attempt/time limits and declarative generated
  surfaces are implemented. Cross-thread goals, executable verifiers/plugins, token budgets and graph
  scheduling remain roadmap items.
- Codex/OpenCode receive brief context but do not yet expose app-native brief mutation tools.
- Brief index consistency assumes one server process per data directory, like the existing store.

- App-native `plan` and `delegate` are currently available to custom OpenAI-compatible Masters.
  ChatGPT OAuth Masters run through Codex CLI and do not yet receive this bridge.
- Assignment worktrees and branches are retained and cannot yet be cleaned up, merged, or pushed
  from the UI. Repository fetch/pull and retry are not yet exposed.
- Knowledge metadata can be edited, but replacing stored document bytes or a repository source
  requires deleting and creating the item again.
- Tasks created before the delegation-completion guard may remain unassigned; their process dialog
  reports that state, but does not retroactively start a Worker.
- OpenCode `plan` is an application policy, not an independent OS or container sandbox.
- Agent profiles cannot yet edit their full configuration after creation; enable, disable, archive,
  and permanent deletion are available.
- Workspaces cannot yet be renamed, reordered, or deleted.
- Device OAuth displays raw Codex CLI instructions; it does not yet use `codex app-server` JSON-RPC.
- Custom providers support only two OpenAI-compatible protocols; Anthropic Messages is not supported.
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
- Queues live in process. A restart marks runs interrupted, and the user must click Retry.
- Markdown code blocks do not yet have syntax highlighting, and web links are not unfurled.
- Artifact deletion, nested replies, reactions, and multi-user authentication are not supported.
- Transcripts use one file per thread, not one file for the entire workspace; this boundary reduces
  contention while preserving one shared source of context for every participant in the thread.
