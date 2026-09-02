# Architecture — state after M3

`docs/PLAN.md` describes where Nexestra is going. This file describes what is
actually in the repository right now, so a reader can tell implemented code
from planned code at a glance.

**Milestone reached: M3 — the Master is wired up.** A vague sentence in the
Chat surface now becomes clarifying questions, a spec with verifiable
acceptance criteria, an approval, and a task DAG on the board — all persisted,
all streamed over the same WebSocket as everything else. What is still missing
is execution: nothing spawns a harness yet (§10).

---

## 1. Package map

| Package | Status after M1 | Contents |
|---------|-----------------|----------|
| `@nexestra/core` | **implemented** | Zod schemas + inferred types for the whole domain model (PLAN.md §3), the `HarnessEvent` union / `RunSpec` / `HarnessAdapter` contract (§5), the persisted event catalogue, the REST request/error schemas, the `/ws` protocol, and the `mock/` fixtures used for seeding and tests. |
| `@nexestra/storage` | **implemented** | Drizzle schema, migrations, `EventStore`, the command surface (`NexestraStore`), projection replay and `seedMock()`. |
| `@nexestra/server` | **implemented** | Hono app on `127.0.0.1:4242`: the `/api` REST surface over the store, a subscribing `/ws`, static serving of `apps/web/dist` in production, **and the Master runtime** (§6) — the runner, the store and host adapters, the `ExecutionHost` seam and the demo model. |
| `@nexestra/web` | **implemented** | React 19 SPA: shell layout, four surfaces, settings, keyboard shortcuts, command palette — all on `/api`, with TanStack Query mutations and a `/ws` connection that folds events into the cache, including a live Master turn. |
| `@nexestra/ui-kit` | **implemented** | Terminal-like component set plus the CSS-variable design tokens for the dark and light palettes. |
| `@nexestra/master` | **implemented** | The Master agent (M2): the phase machine, the per-phase tool surface, strict tool schemas, spec and plan bookkeeping, budget rules, the `LlmClient` / `MasterHost` / `MasterStore` seams and the Anthropic client. A library — no HTTP, no database, no processes. See `docs/master.md`. |
| `@nexestra/adapter-codex` | **implemented** | `HarnessAdapter` over `codex exec --json` (M4): discovery, worktree preparation, JSONL parsing, control and usage, contract-tested against recorded fixtures. Nothing calls it yet — see `docs/adapters/codex.md`. |
| `@nexestra/orchestrator` | **placeholder** | `selectReadyTasks()` and the default concurrency. `createOrchestrator()` throws. It will implement `ExecutionHost` (§6.3) in M4. |
| `@nexestra/adapter-opencode` | **placeholder** | Id + contract-tested version range. Lands in M5. |

### Workspace linking

Every internal package points `main`/`types`/`exports` at `./src/index.ts` —
TypeScript source, not build output. Consequences:

- `apps/web` aliases `@nexestra/*` to the source files in `vite.config.ts`.
- `apps/server` runs under `tsx` in dev, which transpiles the linked sources.
- `pnpm --filter @nexestra/server build` bundles with esbuild, inlining the
  workspace packages and leaving `hono`, `@hono/node-server`, `ws`, `zod`,
  `drizzle-orm` and `better-sqlite3` external.
- There is no per-library build step, so nothing can go stale.

---

## 2. Domain model (`packages/core/src`)

One file per entity under `domain/`, all exported from `src/index.ts`:

| File | Exports |
|------|---------|
| `common.ts` | `IdSchema`, `TimestampSchema`, `EntityBaseSchema`, `HarnessIdSchema`, `SandboxLevelSchema`, `ReasoningLevelSchema`, `RunKindSchema`, `McpServerRefSchema`, `UsageSchema`, `JsonSchemaSchema` |
| `workspace.ts` | `Workspace`, `WorkspaceSettings` |
| `thread.ts` | `Thread`, `ThreadPhase`, `ACTIVE_THREAD_PHASES` |
| `message.ts` | `Message`, `MessageRole`, `MessageReference`, `MessageToolCall`, `MessageAttachment` |
| `spec.ts` | `Spec`, `SpecScope`, `AcceptanceCriterion`, `Verification`, `OpenQuestion`, `Decision` |
| `plan.ts` | `Plan`, `PlanEdge`, `findPlanCycle()` |
| `task.ts` | `Task`, `TaskStatus`, `HarnessConfig`, `BoardColumn` + `boardColumnForStatus()` / `statusForBoardColumn()` |
| `run.ts` | `Run`, `RunStatus`, `RunEvent` |
| `artifact.ts` | `Artifact`, `ArtifactKind` |
| `approval.ts` | `Approval`, `ApprovalKind`, `ApprovalStatus` |
| `memory.ts` | `Memory`, `MemoryType`, `MemoryLink` + `MemoryLinkType`, `MemorySource` |
| `settings.ts` | **(M1)** `AppSettings`, `DEFAULT_APP_SETTINGS` — machine-wide defaults |

Outside `domain/`:

| File | Exports |
|------|---------|
| `harness.ts` | The adapter contract verbatim from PLAN.md §5 |
| `events.ts` | **(M1)** `NexestraEventType` (the catalogue below), `NexestraEvent`, `ENTITY_SNAPSHOT_EVENTS` |
| `api-http.ts` | **(M1)** `ApiError` plus one request schema per mutating route |
| `ws.ts` | **(M1)** `WsClientMessage`, `WsServerMessage`, `WS_HEARTBEAT_INTERVAL_MS` |
| `api.ts` | `HealthResponse`, `FileNode` / `FileContent`, and the deprecated M0 `ServerFrame` / `ClientFrame` |

Import direction is one-way (`domain/common.ts → harness.ts → domain/run.ts`)
so there are no module cycles at zod-evaluation time.

---

## 3. Storage (`packages/storage`)

### 3.1 Shape

```
~/.nexestra/                 (NEXESTRA_HOME overrides)
  nexestra.db                SQLite, WAL mode
  data/                      artifact bytes (written from M4)
```

`createStore()` opens the file, creates the directory if needed, and applies
any outstanding migrations before returning. Nothing else in the codebase
touches SQLite directly.

### 3.2 Tables

One projection table per domain entity — `workspaces`, `threads`, `messages`,
`specs`, `plans`, `tasks`, `runs`, `run_events`, `artifacts`, `approvals`,
`memories` — plus:

- **`memory_links`** `(sourceId, targetId, type)` composite key. The graph's
  single source of truth; `Memory.links` is hydrated from it on read, so the
  UI still sees the embedded array the schema declares.
- **`events`** `(id, workspaceId, threadId?, runId?, seq, type, payload, createdAt)`.
  Append-only. `seq` is monotonic **per thread**, starting at 0 with
  `thread.created`; events with no `threadId` (workspace-level: `workspace.*`,
  `settings.updated`) are sequenced per workspace instead.
- **`settings`** `(key, value, updatedAt)` — a single JSON row keyed `app`.
- **`master_messages`** `(id, workspaceId, threadId, seq, role, content, createdAt)` and
  **`master_state`** `(threadId, workspaceId, state, updatedAt)` **(M3)** — the
  Master's own working memory: the raw API content blocks of its conversation,
  verbatim, plus the serialised `MasterThreadState`. These are the only tables
  written without an accompanying event, because nothing replays them and the
  user-visible transcript still lives in `messages` (§6.2).

Conventions: ids and timestamps are text (ISO-8601, matching the zod schemas);
anything the domain models as a nested object or array is a JSON column, so a
row round-trips through its schema unchanged; booleans are integers.

### 3.3 Migrations

`src/schema.ts` is the source of truth. `pnpm --filter @nexestra/storage db:generate`
runs drizzle-kit into `drizzle/` **and** embeds the statements into
`src/migrations.ts`. The runtime applies the embedded array and records applied
tags in `__nexestra_migrations`.

The indirection exists because the server ships as a single esbuild bundle:
resolving `drizzle/` from `import.meta.url` would break in `dist/`. A test
asserts the embedded copy still matches the folder, so the two cannot drift.

### 3.4 Commands and events

Every write goes through a command on `NexestraStore`. A command writes its
projection row **and** appends the matching event inside one SQLite
transaction, so the log can never disagree with the projections:

```
createWorkspace   updateWorkspace
createThread      updateThread
addMessage
upsertSpec        upsertPlan
createTask        updateTask     updateTaskStatus   reorderTasks   deleteTask
recordRun         appendRunEvent
recordArtifact
createApproval    resolveApproval
upsertMemory      updateMemory   deleteMemory       linkMemories   unlinkMemories
putSettings
```

Plus four commands added in M3 that deliberately do **not** append an event —
they are the Master's private scratch space, not a projection:

```
appendMasterMessages   listMasterMessages
putMasterState         getMasterState
```

`EventStore` provides `append()`, `readThread(threadId, afterSeq?)`,
`readWorkspace(workspaceId, afterSeq?)`, `subscribe(target, listener)` (matches
either `threadId` or `workspaceId`) and `subscribeAll(listener)`.

Listeners fire **after** the enclosing transaction commits. A rolled-back
transaction emits nothing, so a WebSocket client can never observe an event
whose projection write was undone.

### 3.5 Event catalogue

`payload` is the **full post-state of the entity** for every event marked ✓,
which is what makes replay a plain upsert.

| Type | Scope | Payload | Emitted by |
|------|-------|---------|-----------|
| `workspace.created` | workspace | ✓ `Workspace` | `createWorkspace` |
| `workspace.updated` | workspace | ✓ `Workspace` | `updateWorkspace` |
| `thread.created` | thread (seq 0) | ✓ `Thread` | `createThread` |
| `thread.updated` | thread | ✓ `Thread` | `updateThread` (no phase change) |
| `thread.phase_changed` | thread | ✓ `Thread` | `updateThread` (phase changed) |
| `message.added` | thread | ✓ `Message` | `addMessage` |
| `spec.upserted` | thread | ✓ `Spec` | `upsertSpec` |
| `spec.frozen` | thread | ✓ `Spec` | `upsertSpec` when `frozen` flips to true |
| `plan.upserted` | thread | ✓ `Plan` | `upsertPlan` |
| `task.created` | thread | ✓ `Task` | `createTask` |
| `task.updated` | thread | ✓ `Task` | `updateTask` (no status change) |
| `task.status_changed` | thread | ✓ `Task` | `updateTask` / `updateTaskStatus` |
| `task.reordered` | thread | `{threadId, taskIds[], updatedAt}` | `reorderTasks` |
| `task.deleted` | thread | `{id, threadId}` | `deleteTask` |
| `run.recorded` | thread + run | ✓ `Run` | `recordRun` (insert **and** update) |
| `run.event_appended` | thread + run | `RunEvent` | `appendRunEvent` |
| `artifact.recorded` | thread + run? | ✓ `Artifact` | `recordArtifact` |
| `approval.requested` | thread | ✓ `Approval` | `createApproval` |
| `approval.resolved` | thread | ✓ `Approval` | `resolveApproval` |
| `memory.upserted` | thread? | ✓ `Memory` | `upsertMemory` |
| `memory.deleted` | thread? | `{id, workspaceId}` | `deleteMemory` |
| `memory.linked` | thread? | `MemoryLinkRow` | `linkMemories` |
| `memory.unlinked` | thread? | `{sourceId, targetId, type}` | `unlinkMemories` |
| `settings.updated` | workspace | `AppSettings` | `putSettings` |
| `master.started` **(M3)** | thread | `{threadId, turnId, phase, trigger}` | `MasterRunner` |
| `master.text_delta` | thread | `{threadId, turnId, text}` | `MasterRunner` |
| `master.tool_call` | thread | `{threadId, turnId, callId, name, input}` | `MasterRunner` |
| `master.tool_result` | thread | `{threadId, turnId, callId, name, ok, output}` | `MasterRunner` |
| `master.question` | thread | `{threadId, turnId, callId, questions[]}` | `MasterRunner` |
| `master.usage` | thread | `{threadId, turnId, turn, thread, budgetUSD}` | `MasterRunner` |
| `master.error` | thread | `{threadId, turnId, error}` | `MasterRunner` |
| `master.done` | thread | `{threadId, turnId, outcome, phase}` | `MasterRunner` |

The `master.*` family is the one exception to the snapshot rule: these events
narrate a turn so the WebSocket can stream it, but no projection hangs off
them and `rebuildProjections` skips them. Everything durable a turn produces
still arrives as an ordinary entity event — `spec.upserted` / `spec.frozen`,
`plan.upserted`, `task.created`, `approval.requested`, `memory.upserted`,
`thread.phase_changed`, and `message.added` for the final assistant message.
Their payloads are validated by `MasterStreamPayloadSchema` in
`packages/core/src/master.ts`.

Text deltas are coalesced into roughly 80-character chunks before they are
appended: a row per token would multiply the log by two orders of magnitude
for no visible difference in the UI.

"Scope" is which id the event carries, and therefore how it is sequenced and
who receives it over `/ws`. A workspace subscription matches
`event.workspaceId`, so it sees thread events too — `thread.created` is
deliberately thread-scoped (it must be seq 0 of the thread's own log) yet still
reaches workspace watchers.

`memory.*` events are thread-scoped only when the memory has a `threadId`;
workspace-scoped memories produce workspace-scoped events.

### 3.6 Replay

`rebuildProjections(store, threadId)` deletes every thread-scoped row and
replays the thread's log in `seq` order. Because entity events carry full
snapshots, each one is an upsert; the replayer only repeats the bookkeeping the
commands do *outside* the entity row (`threads.specId` / `planId` and the
`lastActivityAt` touch), using the timestamps from the payload so the result is
bit-exact.

`packages/storage/src/replay.test.ts` proves this on seeded data, on state
built by ad-hoc commands (including deletes, reorders and unlinks), and after
deliberate mutation.

Workspace-scoped memories are neither cleared nor replayed by a thread rebuild.

### 3.7 Seeding

`seedMock(store)` writes the `@nexestra/core` fixtures through the commands, so
the demo content has a real event log behind it. It is idempotent: a store that
already has a workspace is left alone. Trigger it with `NEXESTRA_SEED_MOCK=1`
or `--seed-mock`.

---

## 4. HTTP API (`apps/server`)

All routes live under `/api`. Bodies are validated with the zod schemas from
`@nexestra/core/api-http`; every failure renders the same envelope from a
single `app.onError`:

```json
{ "error": { "code": "bad_request", "message": "…", "details": { } } }
```

Codes: `bad_request` (400), `not_found` (404), `conflict` (409),
`invalid_workspace_path` (400), `internal` (500).

| Method | Route | Notes |
|--------|-------|-------|
| GET | `/api/health` | `{ ok, version, master }` — `master` says which model client the process started with |
| GET / PUT | `/api/settings` | Machine-wide defaults, plus the read-only `master` runtime block |
| GET | `/api/workspaces` | |
| POST | `/api/workspaces` | `{path, name?, shortLabel?, defaultBranch?, settings?}` — the path must exist and be a git repository |
| GET / PATCH | `/api/workspaces/:id` | |
| GET | `/api/threads?workspaceId=` | |
| POST | `/api/threads` | `{workspaceId, title, summary?, phase?, budgetUSD?}` |
| GET / PATCH | `/api/threads/:id` | PATCH takes `{title?, summary?, phase?, budgetUSD?}` |
| GET / POST | `/api/threads/:id/messages` | |
| GET / PUT | `/api/threads/:id/spec` | GET returns `null` when there is none |
| GET / PUT | `/api/threads/:id/plan` | |
| GET | `/api/threads/:id/events?afterSeq=` | The raw event log |
| POST | `/api/threads/:id/master/send` | **(M3)** `{kind:"user_message"\|"answers"\|"approval"\|"continue", …}` — queues a turn, answers `202 {turnId}`; `409` if a turn is already running and the body is a new user message |
| POST | `/api/threads/:id/master/cancel` | **(M3)** Aborts the in-flight model request |
| GET | `/api/threads/:id/master/state` | **(M3)** Phase, `busy`, the pending question or approval, spec, usage, budget and the runtime |
| GET | `/api/tasks?threadId=` | `threadId` is required |
| POST | `/api/tasks` | |
| POST | `/api/tasks/reorder` | `{threadId, taskIds[]}` — index becomes `Task.order` |
| GET / PATCH / DELETE | `/api/tasks/:id` | |
| POST | `/api/tasks/:id/status` | `{status, order?}` — what a board drag calls |
| GET | `/api/runs?threadId=` | |
| GET | `/api/runs/:id`, `/api/runs/:id/events?afterSeq=` | |
| GET | `/api/artifacts?threadId=`, `/api/artifacts/:id` | |
| GET | `/api/artifacts/:id/content` | Reads `~/.nexestra/data`, falls back to the inline preview and says which in `source` |
| GET | `/api/approvals?workspaceId=&threadId=&status=` | |
| POST | `/api/approvals` | |
| GET | `/api/approvals/:id` | |
| POST | `/api/approvals/:id/resolve` | `{status, resolvedBy?}`; 409 if already resolved. **(M3)** Also resumes a Master turn suspended on that approval |
| GET | `/api/memories?workspaceId=&threadId=` | Links hydrated from `memory_links` |
| POST | `/api/memories` | |
| GET / PATCH / DELETE | `/api/memories/:id` | |
| POST | `/api/memories/:id/links` | `{targetId, type, note?}` |
| DELETE | `/api/memories/:id/links/:targetId?type=` | |

Runs and artifacts are read-only over HTTP: the orchestrator writes them
through the store from M4.

`POST …/master/send` is deliberately fire-and-forget. It validates the body,
queues the turn and returns; the turn itself streams over `/ws`, so no HTTP
request is ever held open for the length of a model call and a browser that
reloads mid-turn rejoins by subscribing rather than by retrying.

### 4.1 Still mocked

Grouped in `src/routes/placeholders.ts` so it is obvious what is not real:

| Route | Becomes real in |
|-------|-----------------|
| `GET /api/files`, `/api/files/content?path=` | M4 (worktree file tree) |
| `GET /api/terminal` | M4 (run stdout) |
| `GET /api/harnesses` | M4 / M5 (`codex` / `opencode` detection) |

---

## 5. WebSocket protocol (`/ws`)

Client → server (`WsClientMessage`):

```jsonc
{ "type": "subscribe",   "threadId": "th_…" }   // workspaceId also accepted
{ "type": "unsubscribe", "threadId": "th_…" }
{ "type": "ping" }
```

Server → client (`WsServerMessage`):

```jsonc
{ "type": "hello",      "serverVersion": "0.0.0-m1", "at": "…" }
{ "type": "subscribed", "threadIds": [], "workspaceIds": [] }
{ "type": "event",      "event": { /* NexestraEvent */ } }
{ "type": "pong",       "at": "…" }
{ "type": "error",      "message": "unrecognised frame" }
```

An event is delivered when its `threadId` is in the socket's thread set, or its
`workspaceId` is in the workspace set. The server keeps **one** store-wide
listener and fans out from it, so subscribing is O(1) and no listener leaks
when a socket closes.

Heartbeat: the server sends a protocol-level ping every 30s
(`WS_HEARTBEAT_INTERVAL_MS`) and terminates a socket that misses two, so a tab
that vanished without a close frame does not keep its subscription.

The M0 `ServerFrame` / `ClientFrame` in `api.ts` are deprecated but still
exported.

---

## 6. The Master runtime (`apps/server/src/master`)

`@nexestra/master` is a library with three seams — the model (`LlmClient`),
the world (`MasterHost`) and the transcript (`MasterStore`). M3 is the server
filling all three in, plus a runner that turns a `MasterEvent` stream into
store events.

```
POST /api/threads/:id/master/send        ← user message / answers / approval
        │
        ▼
   MasterRunner            one live MasterSession per thread,
        │                  one turn at a time per thread
        ├── LlmClient      AnthropicLlmClient  |  DemoLlmClient   (§6.4)
        ├── MasterStore    StorageMasterStore  → master_messages / master_state
        └── MasterHost     ServerMasterHost    → NexestraStore commands
                                 └── ExecutionHost  (§6.3, not available yet)
        │
        ▼
   store events  ──►  EventStore  ──►  /ws  ──►  Chat surface
```

### 6.1 `ServerMasterHost`

The only place the Master's decisions become rows. Every write goes through a
`NexestraStore` command, so each one appends its event in the same transaction
and reaches the UI without extra plumbing.

| Callback | What it writes |
|----------|----------------|
| `readWorkspace` / `searchCode` | nothing — `createFsWorkspaceReader` on the workspace's repository root, confined to it |
| `recordMemory` | `upsertMemory` + `linkMemories` (links to nodes that do not exist yet are dropped, not fatal) |
| `requestApproval` | `createApproval`, always `pending`: the decision is the user's |
| `onSpecUpdated` | `upsertSpec` (`spec.frozen` when the approval flips `frozen`) |
| `onPlanProposed` | `upsertPlan` + one `createTask`/`updateTask` per plan task |
| `onPhaseChanged` | `updateThread({phase})` |
| `summarize` | thread summary, plus a `lesson` memory per lesson |
| the six execution callbacks | delegated to `ExecutionHost` |

**Task ids are derived, not mapped.** The model authors its own plan task ids
(`t1`, `scaffold`), and the store needs stable `Task.id`s. Rather than keep a
side table, the id is a pure function of `(threadId, plan task id)`. Three
things fall out of that: a `replan` is an idempotent upsert (the board keeps
its cards, and `status`/`attempts`/`costUSD` survive), the plan row can be
written *before* the tasks because its `taskIds` and `edges` are already
known, and `dispatch_task("t1")` resolves without any bookkeeping. Tasks that
belonged to the plan and are no longer in it are deleted.

### 6.2 `StorageMasterStore`

`master_messages` holds the API content blocks **verbatim** — thinking blocks
with their signatures, compaction blocks, `tool_use` and `tool_result` — because
the session replays them into the next request. Extracting the text would
silently break both adaptive thinking and server-side compaction.

The draft spec in `master_state` is deliberately **not** re-validated through
`SpecSchema` on load. A spec mid-clarification legitimately has an empty
`goal`, which the domain schema rejects; validating here would throw the
thread's state away and restart it at `intake`. The published copy in `specs`
is the validated one.

### 6.3 The `ExecutionHost` seam

`MasterHost` covers the whole agent lifecycle, but everything up to planning is
bookkeeping over the store while everything from `executing` onwards needs git
worktrees, spawned processes and a scheduler. So the execution half is an
injectable interface of its own, in
`apps/server/src/master/execution-host.ts`:

```ts
export interface ExecutionContext {
  readonly workspaceId: string;
  readonly threadId: string;
  /** Absolute path of the workspace repository on this machine. */
  readonly workspacePath: string;
}

export interface ExecutionHost {
  dispatchTask(input: DispatchTaskInput, context: ExecutionContext): Promise<DispatchTaskResult>;
  readRunEvents(input: ReadRunEventsInput, context: ExecutionContext): Promise<ReadRunEventsResult>;
  readArtifact(input: ReadArtifactInput, context: ExecutionContext): Promise<ReadArtifactResult>;
  controlRun(input: ControlRunInput, context: ExecutionContext): Promise<ControlRunOutcome>;
  runVerification(
    input: RunVerificationInput,
    context: ExecutionContext,
  ): Promise<RunVerificationResult>;
  markCriterion(input: MarkCriterionInput, context: ExecutionContext): Promise<MarkCriterionResult>;
  dispatchDefaults?(
    context: ExecutionContext,
  ): TaskDispatchDefaults | Promise<TaskDispatchDefaults>;
}
```

Two guarantees an implementation can rely on: `input.taskId` is always a
persisted `Task.id` (`ServerMasterHost` translates the model's plan ids first,
and rejects an unknown one itself), and `context.workspacePath` is the
absolute, validated repository root.

Until the orchestrator lands, the server injects
`createNotYetAvailableExecutionHost()`, which rejects every call with a message
explaining that Nexestra can plan work but not run it yet. The session turns a
rejection into a `tool_result` with `is_error: true`, so the Master relays the
limitation to the user instead of the turn crashing — and, crucially, it does
not believe a run started.

### 6.4 Which model

`ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) present → `claude-opus-5` via
`createAnthropicLlmClient()`. Otherwise `DemoLlmClient`: a deterministic,
scripted stand-in that reads the workspace, asks three clarifying questions,
drafts a spec with three verifiable acceptance criteria, requests approval and
proposes a four-task plan. It is a real `LlmClient`, so it goes through the
same phase machine, the same strict tool validation and the same store writes
— what it is not is intelligent. `NEXESTRA_MASTER_LLM=demo|anthropic`
overrides the choice; `GET /api/health` and `GET /api/settings` report which
one is live and whether a key was found, never the key itself.

The Master's prompts are Markdown read at run time, which the esbuild bundle
does not carry. `scripts/build.mjs` copies them into `dist/prompts` and
`loadServerPromptSet()` falls back to that when `loadPromptSet()` cannot find
the package sources.

### 6.5 `MasterRunner`

- **Serialisation.** Turns for one thread are chained onto a promise, so a
  second `send()` queues rather than interleaving two model loops over the same
  history. Different threads run concurrently.
- **Narration.** Each `MasterEvent` becomes a `master.*` store event (§3.5).
  `spec_updated`, `plan_proposed`, `approval_requested` and `phase_changed` are
  *not* narrated: they already reached the store through `ServerMasterHost`,
  and copying them would make the UI apply the same change twice.
- **The transcript.** A turn ends with one `master` `Message` carrying the
  text, the tool calls and — when it proposed one — a `plan_preview`
  attachment. The user's half (a message, the answers, an approval decision) is
  written too, so a reloaded thread reads as a conversation.
- **Cost.** Thread usage accumulates into `Thread.costUSD`, the column the
  header and the budget rules already read.
- **Auto-continue.** A turn that ends in `spec_frozen` is followed by a
  `continue`, which is what carries the thread into `planning` and gets the
  plan proposed without the user having to prod it.

### 6.6 Resuming an approval

`request_approval` suspends the turn with a pending tool call.
`POST /api/approvals/:id/resolve` records the decision and then asks the runner
to resume — so Approve in the sidebar is one gesture, not two. Approvals the
Master raised on its own (the 80% budget warning) do not suspend a turn and are
ignored by the resume path.

---

## 7. How data flows

```
apps/web  surfaces                     user edits a task, sends a message…
        │
        ▼  POST/PATCH /api/…           TanStack Query mutation
apps/server  routes/*.ts               zod-validated body
        │
        ▼
packages/storage  NexestraStore        one transaction:
        │                                projection row + events row
        ▼
        events  ──► EventStore listener (after commit)
                        │
                        ▼
                   apps/server ws.ts   {type:"event", event}
                        │
                        ▼
        apps/web lib/events.ts         folds into the query cache
                        │
                        ▼
                   surfaces re-render
```

The web app never imports `@nexestra/core/mock`; it only speaks HTTP and
WebSocket, and re-validates every response with the same schema the server
parsed.

### Web data layer

- `src/lib/api.ts` — a single `keys` table so cache updates cannot drift, an
  `ApiRequestError` carrying the server's error code, one query hook and one
  mutation hook per resource.
- `src/lib/events.ts` — one reference-counted `/ws` connection per tab
  (reconnect with backoff, subscriptions replayed on reopen) and
  `useThreadEvents(workspaceId, threadId)`, mounted by `AppShell`. Entity
  snapshots are written straight into the cache; the rest invalidate.
- `src/lib/store.ts` — Zustand, now session-only: theme, selection, focus.
- `src/lib/master.ts` **(M3)** — `useMasterStream(threadId)` folds the
  `master.*` events off the same socket into the half-written turn (text, tool
  calls, the pending question). It is discarded once the persisted `Message`
  lands, so nothing is rendered twice and a reload falls back to
  `GET /master/state`.

### Interactions that persist

| Surface | Interaction | Route |
|---------|-------------|-------|
| Rail | Add workspace (dialog asking for a repo path) | `POST /api/workspaces` |
| Navigation | New thread | `POST /api/threads` |
| Chat | Send a message to the Master | `POST /api/threads/:id/master/send` |
| Chat | Answer an `ask_user` card | `POST …/master/send` `{kind:"answers"}` |
| Chat | Stop a turn | `POST /api/threads/:id/master/cancel` |
| Chat / sidebar | Approve / reject — records the decision **and** resumes the suspended turn | `POST /api/approvals/:id/resolve` |
| Board | Drag a card between columns (optimistic, rolled back on failure) | `POST /api/tasks/:id/status` |
| Board sidebar | Edit title / agent / status / model / reasoning / sandbox | `PATCH /api/tasks/:id` |
| Memory sidebar | Edit a memory | `PATCH /api/memories/:id` |
| Settings | Read and write defaults | `GET`/`PUT /api/settings` |

Buttons that need a later milestone (`Dispatch`, `View run`, `View changes`,
`Open source`, `+ Add` task) are **disabled** and their tooltip says which
milestone they land in.

---

## 8. Web app structure

```
apps/web/src
  main.tsx              QueryClientProvider + RouterProvider, applies the theme
  router.tsx            code-based TanStack Router route tree
  app.css               layout for the shell, the four surfaces and the dialog
  shell/
    AppShell.tsx        rail | navigation | content; mounts keyboard, palette, /ws
    WorkspaceRail.tsx   48px workspace rail + "add workspace" dialog
    NavigationPanel.tsx THREADS list + "new thread" dialog, SURFACES, Settings
    EmptyWorkspace.tsx  /w/:workspaceId with no thread yet
    PromptDialog.tsx    one-field modal
    SurfaceLayout.tsx   main | sidebar (280px) frame used by every surface
    surfaces.ts         surface descriptors and their route paths
    useShellKeyboard.ts ⌘1..⌘4, ⌘/, ⌘K, ⌘,
    CommandPalette.tsx  ⌘K palette
  surfaces/chat/        ChatSurface, ChatSidebar and the M3 cards:
                        QuestionCard (ask_user), SpecCard (inline + sidebar),
                        PlanCard (plan_preview), ToolCallCard (collapsed),
                        ApprovalBanner
  surfaces/board|editor|memory
  settings/SettingsSurface.tsx
  lib/{api,events,master,store,format}.ts
  test/setup.ts         RTL cleanup (Vitest globals are off on purpose)
```

Routes:

```
/                                            → first thread, or /w/:id, or "no workspace yet"
/w/$workspaceId                              → first thread, or "create one"
/w/$workspaceId/t/$threadId/chat             surface 1
/w/$workspaceId/t/$threadId/board            surface 2
/w/$workspaceId/t/$threadId/editor           surface 3
/w/$workspaceId/t/$threadId/memory           surface 4
/settings
```

Layout is `react-resizable-panels` v4. The navigation (260px) and sidebar
(280px) panels declare explicit `px` sizes and
`groupResizeBehavior="preserve-pixel-size"`, so window resizing only changes
the main pane.

| Surface | Main | Sidebar | Libraries |
|---------|------|---------|-----------|
| Chat | Timeline + the live turn (streaming text, collapsed tool cards), question card, spec card, plan preview, approval banner above the composer | Approval queue, the live Spec, Decisions (spec + `decision` memories), References, Master usage | — |
| Task Board | TODO / IN PROGRESS / DONE columns (REVIEW and BLOCKED appear when occupied), drag between columns; cards carry harness / model / reasoning tags and a "blocked by ‹title›" line | Editable title, agent, status, model, reasoning, sandbox; both directions of the dependency edge; criteria + evidence | `@dnd-kit/core` |
| Editor | File tree, code editor, terminal pane (all still fixtures) | Active run, current task, progress, artifacts | `@uiw/react-codemirror`, `@xterm/xterm` |
| Memory Graph | Nodes coloured by `Memory.type`, typed edges, dagre layout | Selected memory with inline edit | `@xyflow/react`, `@dagrejs/dagre` |

---

## 9. Tooling and quality gates

- TypeScript 5.9, `strict` plus `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`; `moduleResolution: bundler`.
- Biome 2.5 for lint, format and import ordering (`pnpm lint`).
- Vitest 4 (`pnpm test`):
  - `packages/core` parses every fixture through its schema and asserts the
    plan DAG is acyclic;
  - `packages/storage` covers commands + events, sequencing, subscriptions,
    transaction rollback, replay equality and migration drift;
  - `packages/master` runs the whole agent loop against a scripted model — no
    network, no key;
  - `packages/adapters/codex` parses recorded Codex JSONL fixtures;
  - `apps/server` exercises every route group against a temp database, a real
    `/ws` server for subscribe / push / unsubscribe, **and the M3 acceptance
    run**: a scripted model driven through the real store from a vague request
    to four task rows, including the approval resuming a suspended turn and the
    `master.*` events arriving in stream order. The demo model gets the same
    acceptance test, because it is what someone without an API key meets;
  - `apps/web` runs component tests in jsdom (Vitest + React Testing Library),
    aliased to the workspace sources exactly as the app is, so a test cannot
    pass against a stale build.
- `pnpm typecheck` runs `tsc --noEmit` per package in parallel.
- `pnpm build` produces `apps/web/dist` and `apps/server/dist/index.js`.

---

## 10. Known gaps going into M4

- **Nothing runs.** `ExecutionHost` is the `NotYetAvailableExecutionHost`, so
  the Master can plan work and then has to say it cannot start it. `runs` and
  `run_events` are still only written by seeding, and the Editor surface still
  renders fixtures for the file tree, the diff and the terminal. The
  orchestrator implements the interface in M4.
- `@nexestra/adapter-codex` is finished and tested but unreferenced: no code
  path constructs it yet.
- Harness detection in Settings is a fixture; nothing shells out yet.
- The Master runtime lives in the server process, so a restart drops the live
  sessions. State is rebuilt from `master_state` on the next `send()`, but a
  turn that was in flight is lost rather than resumed.
- `master.*` events accumulate in the log with nothing pruning them. Text is
  coalesced, but a long thread will still carry thousands of rows the UI only
  needs while the turn is live.
- The demo model is a script, not a fallback model: it produces a sensible
  shape for any request but does not understand any of them.
- `rebuildProjections` is thread-scoped and exposed as a library function only;
  there is no CLI or route that calls it, and no automatic integrity check at
  startup.
- The seeded demo workspace points at `/Users/dev/Works/Nexestra`, which does
  not exist. It is fixture data, not something the path validation ever saw —
  workspaces created from the UI are validated.
- Artifact bytes are never written, so `/api/artifacts/:id/content` always
  answers from the inline preview.
- The web bundle is still a single ~1.6 MB chunk. Code-splitting per surface is
  worth doing once the surfaces stop changing.
- `apps/web` has component tests for the two M3 cards only; the surfaces
  themselves are untested, and Playwright coverage is still planned for M7.
