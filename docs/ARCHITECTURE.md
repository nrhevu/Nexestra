# Architecture — Milestone M9 fresh rebuild

## Product boundary

M9 is a single-user, local-first control center. The server binds to `127.0.0.1`, the SPA
communicates over HTTP, and the server invokes configured coding harnesses or providers. The two
primary navigation areas are Threads and Surfaces; the first two surfaces are Taskboard and Agents.
The far-left rail switches between workspaces, while the adjacent panel owns the Threads, Surfaces,
and Settings navigation.

## Components

```text
React SPA
   │ HTTP + thread SSE
   ▼
Hono API ── FileStore ── state.json / credentials.json
   │                    ├─ threads/<id>.jsonl
   │                    └─ artifacts/<thread-id>/<artifact-id>
   ▼
ChatService ── AgentDispatcher ── LocalAgentRunner
                                  ├─ codex exec --json (read-only / workspace-write / full)
                                  ├─ opencode run --format json (plan)
                                  └─ MasterHarness ── OpenAI-compatible HTTP
                                                   ├─ built-in tools + user questions
                                                   ├─ workspace/user custom tools
                                                   └─ local/remote MCP servers
```

The shared Zod contracts in `src/shared/contracts.ts` define the boundary between browser and server.

## Refresh and rendering model

The SPA performs no periodic requests while the selected workspace is idle. While the visible
thread has queued, running, approval-waiting, or input-waiting work, it opens one Server-Sent Events
connection. The dispatcher publishes phase changes and accumulated response text directly, and
marks events that require the browser to reload durable messages, runs, or tools. Browsers without
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
Mention highlighting is applied to rendered text nodes while links and code remain untouched.

## Persistence

`state.json` stores workspaces, agent profiles, thread metadata, and tasks. Every agent, thread, and
task carries a workspace ID. Handles and thread slugs are unique only within their workspace, and
task references cannot cross workspace boundaries. Creating a workspace seeds a `general` thread.
Version 1 state is migrated in place to version 2 by assigning every existing record to a default
`Nexestra` workspace; record IDs and transcript paths do not change. Version 2 state migrates to
version 3 by adding the first Master tool permissions; version 3 migrates to version 4 by adding the
complete tool matrix. Version 4 migrates to version 5 by replacing that matrix with one `ask`,
`auto`, or `full` access mode. State writes use a temporary file followed by an atomic rename. The
separate `credentials.json` file has mode `0600` and stores only custom API keys by agent ID.

Permanent agent deletion removes the profile and its custom credential, clears matching task
assignments, and releases the handle for reuse. Credential removal is persisted before public state
so an interrupted multi-file write favors removing the secret. Thread JSONL files are never rewritten
for agent deletion; historical author and mention snapshots remain part of the canonical transcript.

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
rejected. Agent output goes directly to the transcript without passing through the mention parser.

Chat reserves each resolved agent before persisting the user's message, without starting dispatch.
Deletion is rejected while a reservation or per-agent queue is pending or running, and a deletion
tombstone prevents new reservations until the profile update finishes. After an agent is deleted, a
newly typed reference to its old handle is plain text unless that handle has been reused by another
agent. Historical failed runs for a deleted profile cannot be retried.

## Agent runtimes

Worker profiles select either `codex` or `opencode`, with optional model and reasoning-effort
overrides. Worker chat turns always require read-only discussion mode. Codex maps the overrides to
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
shape and up to 512 KB of attached text context. Image provider payloads are capped at 10 MB; larger
artifacts remain indexed but are represented only by metadata.

The Master tool registry provides repository list, glob, grep, read, exact edit, file write,
multi-file patch, bounded shell, skill loading, per-run todos, bounded public web fetch/search, and
interactive questions. LSP is deliberately excluded. Each profile selects one access mode. Ask
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

Custom Chat Completions and Responses requests use their SSE streaming protocols. Text deltas update
the in-memory run projection and are replaced by one final agent message after completion. Codex
`exec --json` and OpenCode `run --format json --thinking` stdout is parsed incrementally, including
records split across process chunks. Native CLI tool events are normalized into the same durable
`tool.updated` history used by the provider-neutral Master. Reasoning content is not copied into the
thread; the UI exposes only a phase label, observable tool activity, and user-facing response text.

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

## Known gaps

- Worker chat runs in read-only discussion mode; Taskboard does not yet dispatch coding jobs or manage worktrees.
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
- Queues live in process. A restart marks runs interrupted, and the user must click Retry.
- Markdown code blocks do not yet have syntax highlighting, and web links are not unfurled.
- Artifact deletion, nested replies, reactions, and multi-user authentication are not supported.
- Transcripts use one file per thread, not one file for the entire workspace; this boundary reduces
  contention while preserving one shared source of context for every participant in the thread.
