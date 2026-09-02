# Architecture — M6 foundation, amended by M8 hardening

`docs/PLAN.md` describes where Nexestra is going. This file describes what is
actually in the repository right now, so a reader can tell implemented code
from planned code at a glance.

**M8 current-state amendment.** Production starts empty, registers only real
Codex/OpenCode harnesses, and requires a configured OpenAI, Anthropic or custom
Master provider. The Master owns research, design, planning and project-memory
work; coding/testing/build work is delegated as persisted tasks. The web shell
uses the Slack-inspired layout recorded in ADR 0021. Older milestone detail
below remains useful, but ADR 0020 wins wherever it mentions demo/fake startup.

**Milestone reached: M6 — the loop is closed.** A vague sentence in the Chat
surface becomes clarifying questions, a spec with verifiable acceptance
criteria, an approved plan, and then *real work*: harness runs in real git
worktrees, a cross-review by a second harness, acceptance criteria proved by
running them, retries with the failure attached, replan requests back to the
Master, and a merge the user approves — all persisted, all streamed over the
same WebSocket as everything else (§11).

---

## 1. Package map

| Package | Status after M1 | Contents |
|---------|-----------------|----------|
| `@nexestra/core` | **implemented** | Zod schemas + inferred types for the whole domain model (PLAN.md §3), the `HarnessEvent` union / `RunSpec` / `HarnessAdapter` contract (§5), the persisted event catalogue, the REST request/error schemas, the `/ws` protocol, and the `mock/` fixtures used for seeding and tests. |
| `@nexestra/storage` | **implemented** | Drizzle schema, migrations, `EventStore`, the command surface (`NexestraStore`), projection replay and `seedMock()`. |
| `@nexestra/server` | **implemented** | Hono app on `127.0.0.1:4242`: the `/api` REST surface over the store, a subscribing `/ws`, static serving of `apps/web/dist` in production, **the Master runtime** (§6) and **the execution runtime** (§11) — the harness registry, the orchestrator, the `MasterBridge` and the worktree readers. |
| `@nexestra/master` | **implemented** | The Master agent: the phase machine, the tool surface per phase, spec and plan construction, and the three seams (`LlmClient`, `MasterHost`, `MasterStore`). |
| `@nexestra/orchestrator` | **implemented** | The dispatch / review / verify loop: scheduler over the task DAG, worktree per task, cross-review, acceptance criteria run as real commands, retry, replan, approval gates, budget, merge, recovery. |
| `@nexestra/adapter-codex` | **implemented** | `codex exec --json` → `HarnessEvent`, plus the git worktree primitives everything else reuses. |
| `@nexestra/adapter-opencode` | **implemented** | `opencode serve` + SSE → `HarnessEvent`, with permission replies and per-workspace server management. |
| `@nexestra/web` | **implemented** | React 19 SPA: shell layout, four surfaces, settings, keyboard shortcuts, command palette — all on `/api`, with TanStack Query mutations and a `/ws` connection that folds events into the cache, including a live Master turn. |
| `@nexestra/ui-kit` | **implemented** | Slack-inspired product components and CSS-variable dark/light tokens; code, diffs and terminals retain the mono tokens. |
| `@nexestra/adapter-fake` | **test only** | Deterministic `HarnessAdapter` injected by unit/integration tests; never registered or exposed by production. |

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
| `events.ts` | **(M1)** `NexestraEventType` (the catalogue below), `NexestraEvent`, `ENTITY_SNAPSHOT_EVENTS`, `MASTER_EVENT_TYPES`, `ORCHESTRATOR_EVENT_TYPES` |
| `execution.ts` | **(M6)** The serialised half of the orchestrator's contracts: `ExecutionStatus`, `OrchestratorProgress`, `RunDiff`, and one request/response schema per execution route |
| `pricing.ts` | **(M6)** `ModelPrice`, `PriceTable`, `DEFAULT_PRICE_TABLE` — token → USD, with an unknown model costing zero |
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
| `orchestrator.progress` **(M6)** | thread | `OrchestratorProgress` | `ExecutionRuntime.notify` |
| `orchestrator.status_changed` **(M6)** | thread | `ExecutionStatus` | `ExecutionRuntime.notify` |

The `master.*` and `orchestrator.*` families are the exceptions to the snapshot
rule: these events narrate a turn or a run so the WebSocket can stream it, but
no projection hangs off them and `rebuildProjections` skips them. Everything
durable the loop produces still arrives as an ordinary entity event —
`run.recorded`, `run.event_appended`, `task.status_changed`,
`artifact.recorded`, `spec.upserted`, `approval.*`. Everything durable a turn produces
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

### 3.7 Test fixture seeding

`seedMock(store)` writes the `@nexestra/core` fixtures through the commands, so
tests can build a database with a real event log behind it. It is idempotent: a
store that already has a workspace is left alone. Production startup has no
seed flag or automatic fixture path; a new installation starts empty.

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
| POST | `/api/threads/:id/execution/(start\|pause\|resume\|cancel)` | **(M6)** Drives the orchestrator; answers an `ExecutionStatus`. `start` also accepts the plan (`planning → executing`) |
| GET | `/api/threads/:id/execution/status` | **(M6)** `ExecutionStatus`: loop state, task counts, live runs, pending approvals, cost against budget |
| POST | `/api/tasks/:id/dispatch` | **(M6)** `{kind?, harness?, instructions?}` — runs one task now, out of band of the scheduler |
| POST | `/api/tasks/:id/verify` | **(M6)** `{criterionIds?}` — runs the task's acceptance criteria and records evidence |
| GET | `/api/runs?threadId=` | |
| GET | `/api/runs/:id`, `/api/runs/:id/events?afterSeq=` | |
| POST | `/api/runs/:id/control` | **(M6)** `cancel` / `steer` / `pause` / `resume` / `answer_permission` on a live run |
| GET | `/api/runs/:id/files` | **(M6)** The run's worktree as a flat `FileNode[]`, marked against the base branch |
| GET | `/api/runs/:id/files/content?path=` | **(M6)** One file's text; refuses a path outside the worktree |
| GET | `/api/runs/:id/diff` | **(M6)** `RunDiff` — the unified diff of the worktree against the branch it was cut from |
| GET | `/api/harnesses?refresh=1` | **(M6)** `discover()` per registered adapter, cached; `refresh=1` re-detects |
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

Runs and artifacts are written only by the orchestrator, through the store —
`/api/runs/:id/control` forwards a `RunControl` to the adapter that owns the
live process; it does not write a row itself.

`POST …/master/send` is deliberately fire-and-forget. It validates the body,
queues the turn and returns; the turn itself streams over `/ws`, so no HTTP
request is ever held open for the length of a model call and a browser that
reloads mid-turn rejoins by subscribing rather than by retrying.

### 4.1 Still mocked

Nothing. `src/routes/placeholders.ts` was deleted in M6: the Editor's file
tree, file contents and terminal are a real run's worktree and event stream,
and `GET /api/harnesses` shells out.

`@nexestra/core/mock` still exists — it is what `seedMock()` writes and what
the core schema tests parse — but no route serves it any more.

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
        ├── LlmClient      OpenAI Responses | Anthropic Messages (§6.4)
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
| `searchMemory` | nothing — searches persisted project/thread memories by query and type |
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

**(M6)** The server now injects an adapter over `orchestrator.host` (§11).
`createNotYetAvailableExecutionHost()` still exists — it is the fallback for a
`MasterRunner` constructed without an execution host, and what the M3 tests
still use — and it rejects every call with a message explaining that Nexestra
can plan work but not run it. The session turns a rejection into a
`tool_result` with `is_error: true`, so the Master relays the limitation to the
user instead of the turn crashing, and does not believe a run started.

### 6.4 Which model

`AppSettings.masterProviders` is the persisted registry for OpenAI Responses,
Anthropic Messages and protocol-compatible custom endpoints. Each entry stores
metadata plus the name of a server environment variable; its secret value
never reaches SQLite or the browser. `activeMasterProviderId` selects the
provider, and changes apply on the next turn without restarting the server.

The OpenAI client sends `store: false` and translates the canonical durable
history and strict Master tools into Responses API items. The built-in model is
`chat-latest` and is editable (for example to `gpt-5.6`). The Anthropic client
supports a configurable base URL and Claude model. With no ready provider,
health/settings report `configuration required` and a Master turn fails
honestly; there is no scripted fallback. See ADR 0020.

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

### 6.6 The Master's draft spec and the loop's evidence

Two copies of the spec exist and they have different owners. The *wording* is
the Master's and lives in `master_state`; `satisfied` and `evidenceArtifactId`
are facts produced by running a criterion, which the orchestrator writes onto
the published spec in `specs`.

`StorageMasterStore.loadState` folds the published evidence back onto the draft
on every load. Without it the phase guard for `all_criteria_verified` reads a
snapshot taken before any verification ran, and a thread that proved everything
can never reach `done`.

### 6.7 Resuming an approval

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

**(M6)** Two execution reads follow the same pattern as the Master's: the query
is the durable copy that makes a reload correct, and `/ws` keeps it fresh.
`useExecutionStatus` is seeded by `GET …/execution/status` and then *replaced*
by each `orchestrator.status_changed`; `useThreadProgress` reads the
`orchestrator.progress` rows back out of the thread's event log and appends new
ones as they arrive.

`run.event_appended` is **appended** to `keys.runEvents(runId)` rather than
invalidating it. A refetch per line would be one HTTP request per token of
    harness output, and the terminal writes only the tail it has not written yet.

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
| Board header | `[Start execution]` / `[Pause]` / `[Resume]` / `[Cancel]` **(M6)** | `POST /api/threads/:id/execution/…` |
| Board sidebar | `[Dispatch]` / `[Verify]` a single task **(M6)** | `POST /api/tasks/:id/dispatch` / `…/verify` |
| Editor | `[Cancel run]` **(M6)** | `POST /api/runs/:id/control` |
| Navigation | Approve / reject anything in the queue **(M6)** | `POST /api/approvals/:id/resolve` |
| Settings | `[Refresh detection]` **(M6)** | `GET /api/harnesses?refresh=1` |
| Board sidebar | Edit title / agent / status / model / reasoning / sandbox | `PATCH /api/tasks/:id` |
| Memory sidebar | Edit a memory | `PATCH /api/memories/:id` |
| Settings | Read and write defaults | `GET`/`PUT /api/settings` |

**(M6)** The only buttons still disabled for a later milestone are `+ Add` task
on the board and `Open source` in the memory sidebar.

---

## 8. Web app structure

```
apps/web/src
  main.tsx              QueryClientProvider + RouterProvider, applies the theme
  router.tsx            code-based TanStack Router route tree
  app.css               layout for the shell, the four surfaces and the dialog
  shell/
    AppShell.tsx        rail | navigation | content; mounts keyboard, palette, /ws
    WorkspaceRail.tsx   workspace rail + "add workspace" dialog
    NavigationPanel.tsx THREADS list + "new thread" dialog, SURFACES, Settings
    EmptyWorkspace.tsx  /w/:workspaceId with no thread yet
    PromptDialog.tsx    one-field modal
    SurfaceLayout.tsx   main | sidebar (280px) frame used by every surface
    surfaces.ts         surface descriptors and their route paths
    useShellKeyboard.ts ⌘1..⌘4, ⌘/, ⌘K, ⌘,
    CommandPalette.tsx  ⌘K palette
    ApprovalQueue.tsx   every pending approval, of every kind (M6)
    ApprovalQueuePanel  the queue wired to the workspace, plus the rail badge
  surfaces/chat/        ChatSurface, ChatSidebar and the M3 cards:
                        QuestionCard (ask_user), SpecCard (inline + sidebar),
                        PlanCard (plan_preview), ToolCallCard (collapsed),
                        ApprovalBanner
  surfaces/editor/      EditorSurface + useActiveRun, FileTree, CodePane,
                        DiffPane, TerminalPane and `terminal.ts` — the pure
                        `RunEvent[] → lines` reducer behind the xterm pane (M6)
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
| Chat | Timeline + the live turn (streaming text, collapsed tool cards), question card, spec card, plan preview, approval banner above the composer, and the orchestrator's progress interleaved by time as compact system rows | Cost against budget, the thread's approvals, the live Spec, Decisions (spec + `decision` memories), References, Master usage | — |
| Task Board | TODO / IN PROGRESS / DONE columns (REVIEW and BLOCKED appear when occupied), drag between columns; cards carry harness / model / reasoning tags, a spinner while a harness is on them, attempts, cost and `mergeState`; the header carries the loop's state and its three verbs | Editable title, agent, status, model, reasoning, sandbox; both directions of the dependency edge; criteria + evidence; the task's runs; `[Dispatch]` / `[Verify]` | `@dnd-kit/core` |
| Editor | One `Run`, from three angles: its worktree file tree, a file in CodeMirror, the unified diff behind `[View changes]`, and its event stream in xterm. The run is picked in the header and defaults to the newest running one | Harness, model, kind, session, tokens, cost; the current task; progress measured in **criteria satisfied**; artifacts; `[View changes]` / `[Cancel run]` | `@uiw/react-codemirror`, `@xterm/xterm` |
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
    `master.*` events arriving in stream order. Deterministic model clients are
    injected only by tests; production never selects them;
  - `apps/web` runs component tests in jsdom (Vitest + React Testing Library),
    aliased to the workspace sources exactly as the app is, so a test cannot
    pass against a stale build — the two M3 cards, the **approval queue** and
    the **run terminal reducer**;
  - `apps/server/src/execution/execution.test.ts` **(M6)** is the acceptance
    run: only the test-injected model (`DemoLlmClient`) and harness
    (`createFakeHarnessAdapter`) are stubbed, and everything between them is
    production code — the phase machine, `ServerMasterHost`, the real
    `ThreadEngine`, real git worktrees on a temp repository, real verification
    commands run through a shell, the SQLite writes and the event log. Four
    cases: a vague sentence carried to `done` with the DAG respected and every
    criterion carrying evidence; an approval gate that blocks the pipeline and
    is released by the REST route; a task that burns its attempts and ends as a
    replan request; and a crash repaired by `recoverAll()` on the next start.
- `pnpm typecheck` runs `tsc --noEmit` per package in parallel.
- `pnpm build` produces `apps/web/dist` and `apps/server/dist/index.js`.

---

## 10. The execution runtime (`apps/server/src/execution`) **(M6)**

`@nexestra/orchestrator` is a library with three seams — the harnesses
(`HarnessAdapter`), the Master (`MasterBridge`) and the world (`NexestraStore`).
M6 is the server filling all three in.

```
POST /api/threads/:id/execution/start
        │
        ▼
   ExecutionRuntime ─────────────────────────────► Orchestrator
        │  (is the MasterBridge)                        │
        │                                               ├── HarnessAdapter  codex | opencode
        ├── notify()  ──► orchestrator.* store events    ├── git worktree per task
        │             └─► MasterSession.applyTrigger     └── NexestraStore   runs, events, artifacts
        ├── requestReplan() ──► MasterRunner.send({kind:"continue"})
        └── host ──────────────► the Master's six execution tools
        │
        ▼
   store events  ──►  EventStore  ──►  /ws  ──►  every surface
```

| File | Responsibility |
|------|----------------|
| `harnesses.ts` | Builds the production Codex/OpenCode registry and caches `discover()` (it shells out). `NEXESTRA_HARNESSES=codex` registers only what is named. Discovery enumerates registered adapters only; `dispose()` kills the OpenCode servers. |
| `runtime.ts` | `ExecutionRuntime`: owns the orchestrator, **is** the `MasterBridge`, exposes the `ExecutionHost` the Master's host delegates to, sweeps `recover()` at startup, lands approved merges, and disposes everything on a signal. |
| `progress.ts` | `OrchestratorEvent` → one `OrchestratorProgress` line. The browser never has to know the loop's union. |
| `files.ts` | The Editor's data: a run's worktree as a tree (marked against the base branch), one file's text, and the unified diff. |
| `fake-script.ts` | Integration-test support: deterministic worktree writes used only with an injected test adapter. |

### 10.1 Configuration

`AppSettings` supplies `concurrency`, `maxAttempts`, `autoMerge` and
`budgetUSD`; `DEFAULT_PRICE_TABLE` from `@nexestra/core` turns
tokens into dollars. Worktrees live at
`$NEXESTRA_HOME/worktrees/<threadId>/<taskId>`.

An **unknown model costs zero** rather than a guess — including a run with no
`model` set at all, which uses the harness's own default. That is a deliberate
choice: a wrong number would pause a thread on money it never spent, and the
visible `$0.00` is honest about not knowing.

### 10.2 The bridge: what the loop does to `Thread.phase`

The orchestrator never writes `Thread.phase` — that machine belongs to the
Master. `notify()` translates:

| Event | Trigger | Phase |
|-------|---------|-------|
| `thread_started` | `plan_accepted` (only from `planning`) | `executing` |
| `thread_idle` / `completed` | `all_tasks_done` | `verifying` |
| …every criterion has evidence | `all_criteria_verified` | `done`, then a `continue` asking for the summary |
| …some do not | *(none)* | stays `verifying`, with a `continue` naming what is missing |
| `thread_idle` / `failed`, `blocked`, `budget_exceeded` | `blocked` | `blocked` |
| `thread_idle` / `paused`, `cancelled` | *(none)* | the user did that on purpose |

Triggers are queued on the same chain as `send()`, so one can never interleave
with a turn that is halfway through rewriting the state.

`requestReplan()` sends a `continue` carrying the whole `ReplanEvidence`.
It **refuses** on a thread with no `master_state`: a `continue` on a thread the
Master has never seen starts its session at `intake`, where the first thing it
does is `update_spec` — republishing an empty draft over the real spec. Such a
thread gets an error line on the log instead.

### 10.3 Startup and shutdown

`recoverAll()` runs **before the first request**: it enumerates threads with a
`running` or `pending` run and calls `orchestrator.recover()` on each, which
marks the runs `interrupted`, resets their tasks and prunes worktrees no live
task claims. `recover()` is per thread by design, so the sweep lives here.

`SIGINT` / `SIGTERM` closes the WebSocket server, then `dispose()`: the
orchestrator cancels every live run (`adapter.control(runId, {action:"cancel"})`,
which kills the Codex process groups), then the registry disposes the adapters,
which shuts down the OpenCode servers this process started.

### 10.4 Merging

The loop raises a `merge` Approval and stops — landing a branch belongs to
whoever owns the checkout, which is this process. `ExecutionRuntime` subscribes
to `approval.resolved`, and an approved `merge` runs `mergeTaskBranch()` behind
a single queue, then writes `mergeState` and says what happened on the log.
`mergeTaskBranch` refuses rather than forces: a dirty tree or a different
branch checked out leaves the branch alone and explains why, so an approval is
never silently lost.

---

## 11. Known gaps going into M7

- **`pause()` does not suspend a live run.** It stops dispatching; runs already
  in flight finish. Suspending mid-run needs `codex app-server`, which the
  Codex adapter does not use.
- **Cost is often `$0.00`.** Pricing keys on the model name, so a task that
  leaves `model` unset — using the harness's own default — is priced at zero
  even though tokens were spent. Set a model to get a number.
- **`gpt-5.1-codex` is not a safe default for every account.** It is what
  `AppSettings.defaultModel` says and what the planning prompt shows the model,
  but a Codex CLI signed in with a ChatGPT account rejects it (and
  `gpt-5.1-codex-mini`) with a 400. Leaving the model unset works everywhere;
  `KNOWN_CODEX_MODELS` is a static hint, not detection.
- **Agentic Master work requires a configured provider.** Without a usable
  server-side credential, the app remains usable for persisted project data but
  does not generate questions, specs or plans.
- **One process owns the store.** The approval gate waits on the in-process
  `EventStore` fan-out, so a second process resolving an approval in the same
  SQLite file would not release the waiter.
- The Master runtime lives in the server process, so a restart drops the live
  sessions. State is rebuilt from `master_state` on the next `send()`, but a
  turn that was in flight is lost rather than resumed.
- `master.*` and `orchestrator.*` events accumulate in the log with nothing
  pruning them. Text is coalesced and progress is one row per loop event, but a
  long thread will still carry thousands of rows the UI only needs while the
  work is live.
- `rebuildProjections` is thread-scoped and exposed as a library function only;
  there is no CLI or route that calls it, and no automatic integrity check at
  startup.
- The web bundle is still a single ~1.6 MB chunk. Code-splitting per surface is
  worth doing once the surfaces stop changing.
- The Slack-inspired shell is desktop-first. Narrow screens reduce top-bar
  detail but do not yet collapse the resizable navigation/context panels into
  mobile drawers.
- **A cancelled run leaves its worktree behind** until the next `recover()`
  prunes worktrees no live task claims. Nothing cleans up after a thread that
  finishes normally either, so `$NEXESTRA_HOME/worktrees` grows.
