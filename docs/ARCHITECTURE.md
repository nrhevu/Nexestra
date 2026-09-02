# Architecture — state after M1

`docs/PLAN.md` describes where Nexestra is going. This file describes what is
actually in the repository right now, so a reader can tell implemented code
from planned code at a glance.

**Milestone reached: M1 — server, storage, realtime.** The four surfaces run on
a real SQLite event store; a reload no longer loses anything.

---

## 1. Package map

| Package | Status after M1 | Contents |
|---------|-----------------|----------|
| `@nexestra/core` | **implemented** | Zod schemas + inferred types for the whole domain model (PLAN.md §3), the `HarnessEvent` union / `RunSpec` / `HarnessAdapter` contract (§5), the persisted event catalogue, the REST request/error schemas, the `/ws` protocol, and the `mock/` fixtures used for seeding and tests. |
| `@nexestra/storage` | **implemented** | Drizzle schema, migrations, `EventStore`, the command surface (`NexestraStore`), projection replay and `seedMock()`. |
| `@nexestra/server` | **implemented** | Hono app on `127.0.0.1:4242`: the real `/api` REST surface over the store, `/api/settings`, `/api/health`, a subscribing `/ws`, and static serving of `apps/web/dist` in production. No orchestration yet. |
| `@nexestra/web` | **implemented** | React 19 SPA: shell layout, four surfaces, settings, keyboard shortcuts, command palette — all on `/api`, with TanStack Query mutations and a `/ws` connection that folds events into the cache. |
| `@nexestra/ui-kit` | **implemented** | Terminal-like component set plus the CSS-variable design tokens for the dark and light palettes. |
| `@nexestra/master` | **placeholder** | The per-phase tool table from PLAN.md §4.1 and the model id. `createMaster()` throws. Lands in M2. |
| `@nexestra/orchestrator` | **placeholder** | `selectReadyTasks()` and the default concurrency. `createOrchestrator()` throws. Lands in M4. |
| `@nexestra/adapter-codex` | **placeholder** | Id + contract-tested version range. Lands in M4. |
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
| GET | `/api/health` | `{ ok, version }` |
| GET / PUT | `/api/settings` | Machine-wide defaults |
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
| POST | `/api/approvals/:id/resolve` | `{status, resolvedBy?}`; 409 if already resolved |
| GET | `/api/memories?workspaceId=&threadId=` | Links hydrated from `memory_links` |
| POST | `/api/memories` | |
| GET / PATCH / DELETE | `/api/memories/:id` | |
| POST | `/api/memories/:id/links` | `{targetId, type, note?}` |
| DELETE | `/api/memories/:id/links/:targetId?type=` | |

Runs and artifacts are read-only over HTTP: the orchestrator writes them
through the store from M4.

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

## 6. How data flows in M1

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

### Interactions that persist

| Surface | Interaction | Route |
|---------|-------------|-------|
| Rail | Add workspace (dialog asking for a repo path) | `POST /api/workspaces` |
| Navigation | New thread | `POST /api/threads` |
| Chat | Send a message (no Master reply until M2) | `POST /api/threads/:id/messages` |
| Chat sidebar | Approve / reject an approval | `POST /api/approvals/:id/resolve` |
| Board | Drag a card between columns (optimistic, rolled back on failure) | `POST /api/tasks/:id/status` |
| Board sidebar | Edit title / assigned agent / status | `PATCH /api/tasks/:id` |
| Memory sidebar | Edit a memory | `PATCH /api/memories/:id` |
| Settings | Read and write defaults | `GET`/`PUT /api/settings` |

Buttons that need a later milestone (`Dispatch`, `View run`, `View changes`,
`Open source`, `+ Add` task) are **disabled** and their tooltip says which
milestone they land in.

---

## 7. Web app structure

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
  surfaces/chat|board|editor|memory
  settings/SettingsSurface.tsx
  lib/{api,events,store,format}.ts
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
| Chat | Message timeline, inline agent-response cards, composer | Approval queue (live), Requirements, Decisions, References | — |
| Task Board | TODO / IN PROGRESS / DONE columns (REVIEW and BLOCKED appear when occupied), drag between columns | Editable title, agent, status; criteria + evidence | `@dnd-kit/core` |
| Editor | File tree, code editor, terminal pane (all still fixtures) | Active run, current task, progress, artifacts | `@uiw/react-codemirror`, `@xterm/xterm` |
| Memory Graph | Nodes coloured by `Memory.type`, typed edges, dagre layout | Selected memory with inline edit | `@xyflow/react`, `@dagrejs/dagre` |

---

## 8. Tooling and quality gates

- TypeScript 5.9, `strict` plus `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`; `moduleResolution: bundler`.
- Biome 2.5 for lint, format and import ordering (`pnpm lint`).
- Vitest 4 (`pnpm test`):
  - `packages/core` parses every fixture through its schema and asserts the
    plan DAG is acyclic;
  - `packages/storage` covers commands + events, sequencing, subscriptions,
    transaction rollback, replay equality and migration drift;
  - `apps/server` exercises every route group against a temp database, plus a
    real `/ws` server for subscribe / push / unsubscribe.
- `pnpm typecheck` runs `tsc --noEmit` per package in parallel.
- `pnpm build` produces `apps/web/dist` and `apps/server/dist/index.js`.

---

## 9. Known gaps going into M2

- No Master: the chat composer stores a user message and nothing answers it.
- No orchestration: `runs` and `run_events` are only ever written by seeding,
  so the Editor surface still renders fixtures for the file tree, the diff and
  the terminal.
- Harness detection in Settings is a fixture; nothing shells out yet.
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
- No component tests for `apps/web`; Playwright coverage is planned for M7.
