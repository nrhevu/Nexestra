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
   │ HTTP + polling
   ▼
Hono API ── FileStore ── state.json / credentials.json
   │                    └─ threads/<id>.jsonl
   ▼
ChatService ── AgentDispatcher ── LocalAgentRunner
                                  ├─ codex exec --json (read-only)
                                  ├─ opencode run --format json (plan)
                                  └─ OpenAI-compatible HTTP
```

The shared Zod contracts in `src/shared/contracts.ts` define the boundary between browser and server.

## Refresh and rendering model

The SPA performs no periodic requests while the selected workspace is idle. While the visible
thread has queued or running work, it polls only that thread once per second. If work continues
after the user navigates elsewhere, a lightweight activity endpoint is polled instead; the full
workspace bootstrap is refreshed once when activity finishes. The dispatcher keeps this live-run
projection in memory, while JSONL run events remain the durable source used for restart recovery.

Harness installation and ChatGPT login status are cached for 30 seconds and explicitly invalidated
by the login flow. In React, search input owns its local state and the transcript is a memoized render
boundary. Runs are grouped by trigger in one pass, so typing does not rebuild message rows and a
transcript refresh does not perform a messages-by-runs nested scan.

## Persistence

`state.json` stores workspaces, agent profiles, thread metadata, and tasks. Every agent, thread, and
task carries a workspace ID. Handles and thread slugs are unique only within their workspace, and
task references cannot cross workspace boundaries. Creating a workspace seeds a `general` thread.
Version 1 state is migrated in place to version 2 by assigning every existing record to a default
`Nexestra` workspace; record IDs and transcript paths do not change. State writes use a temporary
file followed by an atomic rename. The separate `credentials.json` file has mode `0600` and stores
only custom API keys by agent ID.

Permanent agent deletion removes the profile and its custom credential, clears matching task
assignments, and releases the handle for reuse. Credential removal is persisted before public state
so an interrupted multi-file write favors removing the secret. Thread JSONL files are never rewritten
for agent deletion; historical author and mention snapshots remain part of the canonical transcript.

Each thread has one canonical JSONL file. The `message.created` and `run.updated` events use a
monotonically increasing sequence. User messages are appended and fsynced before agents are queued.
Read projections select messages by sequence and the final state of each run. On startup, only an
incomplete JSONL tail is truncated. After a restart, queued or running runs are completed if their
replies were fsynced; otherwise, they are marked interrupted and can be retried.

## Mention and dispatch

`ChatService` resolves handles case-insensitively inside the thread's workspace and removes
duplicates. Unknown handles remain plain text. Each known handle creates one run; disabled or
unavailable agents create explicit failed runs. The dispatcher maintains one promise queue per
agent, so each agent replies serially while different agents can run in parallel. Every invocation
is tied to the exact triggering message ID and content; stale or duplicate retries are rejected.
Agent output goes directly to the transcript without passing through the mention parser.

Chat reserves each resolved agent before persisting the user's message, without starting dispatch.
Deletion is rejected while a reservation or per-agent queue is pending or running, and a deletion
tombstone prevents new reservations until the profile update finishes. After an agent is deleted, a
newly typed reference to its old handle is plain text unless that handle has been reused by another
agent. Historical failed runs for a deleted profile cannot be retried.

## Agent runtimes

Worker profiles select either `codex` or `opencode`, with optional model and reasoning-effort
overrides. Chat turns always require read-only discussion mode. Codex maps the overrides to
`--model` and `model_reasoning_effort`; OpenCode maps them to `--model` and its provider-specific
`--variant`. Missing overrides preserve the harness defaults. Master profiles select one of the
following:

- ChatGPT: uses the Codex CLI session; device-login output remains in memory, and tokens never enter the app.
- Custom: uses OpenAI Chat Completions or Responses with an API root, model, and optional API key.

Child processes close stdin, enforce timeouts and output caps, kill the process group, and inherit
only allowlisted environment variables to reduce the risk of exposing server secrets. A timeout
sends TERM, then KILL after a grace period, and reports an error only after the process exits.

## Security model

The application trusts the current OS user and user-supplied custom endpoints. The server binds only
to loopback and rejects browser mutations whose Origin is outside loopback. Codex CLI manages OAuth
tokens. Custom API keys remain plaintext at rest in a `0600` file, which fits the local single-user
threat model but does not replace an OS keychain. Custom base URLs may not contain user info, a
query, or a fragment; remote endpoints require HTTPS, while HTTP is permitted only on loopback.
Provider responses have a byte limit enforced before parsing.

## Known gaps

- Active chat runs currently poll once per second instead of streaming tokens in real time.
- Worker chat runs in read-only discussion mode; Taskboard does not yet dispatch coding jobs or manage worktrees.
- OpenCode `plan` is an application policy, not an independent OS or container sandbox.
- Agent profiles cannot yet edit their full configuration after creation; enable, disable, archive,
  and permanent deletion are available.
- Workspaces cannot yet be renamed, reordered, or deleted.
- Device OAuth displays raw Codex CLI instructions; it does not yet use `codex app-server` JSON-RPC.
- Custom providers support only two OpenAI-compatible protocols; Anthropic Messages is not supported.
- Queues live in process. A restart marks runs interrupted, and the user must click Retry.
- Agent messages currently render as plain text, without Markdown, code blocks, or link previews.
- Uploads, nested replies, reactions, and multi-user authentication are not supported.
- Transcripts use one file per thread, not one file for the entire workspace; this boundary reduces
  contention while preserving one shared source of context for every participant in the thread.
