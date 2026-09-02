# Architecture — state after M0

`docs/PLAN.md` describes where Nexestra is going. This file describes what is
actually in the repository right now, so a reader can tell implemented code
from planned code at a glance.

**Milestone reached: M0 — monorepo skeleton + the four surfaces on mock data.**

---

## 1. Package map

| Package | Status after M0 | Contents |
|---------|-----------------|----------|
| `@nexestra/core` | **implemented** | Zod schemas + inferred types for the whole domain model (PLAN.md §3), the `HarnessEvent` union / `RunSpec` / `HarnessAdapter` contract (§5), the HTTP + WebSocket wire types, and the `mock/` fixtures the UI renders in M0. |
| `@nexestra/ui-kit` | **implemented** | Terminal-like component set (`Pane`, `Rail`, `KeyHint`, `Kbd`, `StatusDot`, `Tag`, `Button`, `Select`, `TextInput`, `Checkbox`, `MonoTable`, `Composer`) plus the CSS-variable design tokens for the dark and light palettes. |
| `@nexestra/server` | **partial** | Hono app on `127.0.0.1:4242`: `GET /api/health`, the read-only `GET /api/mock/*` API, a `ws` endpoint at `/ws` that sends one `hello` frame, and static serving of `apps/web/dist` in production. No storage, no orchestration. |
| `@nexestra/web` | **implemented (static)** | React 19 SPA: shell layout, four surfaces, settings, keyboard shortcuts, command palette. Reads everything through `/api/mock/*`. |
| `@nexestra/storage` | **placeholder** | Path helpers for `~/.nexestra`. `openStore()` throws. Drizzle schema + event store land in M1. |
| `@nexestra/master` | **placeholder** | The per-phase tool table from PLAN.md §4.1 and the model id. `createMaster()` throws. Lands in M2. |
| `@nexestra/orchestrator` | **placeholder** | `selectReadyTasks()` (all `dependsOn` done) and the default concurrency. `createOrchestrator()` throws. Lands in M4. |
| `@nexestra/adapter-codex` | **placeholder** | Id + contract-tested version range. `createCodexAdapter()` throws. Lands in M4. |
| `@nexestra/adapter-opencode` | **placeholder** | Id + contract-tested version range. `createOpenCodeAdapter()` throws. Lands in M5. |

The placeholder packages exist so later milestones can be filled in without
touching workspace configuration: each has a `package.json`, a `tsconfig.json`
extending `tsconfig.base.json`, and a `src/index.ts`.

### Workspace linking

Every internal package points `main`/`types`/`exports` at `./src/index.ts` —
TypeScript source, not build output. Consequences:

- `apps/web` aliases `@nexestra/*` to the source files in `vite.config.ts`.
- `apps/server` runs under `tsx` in dev, which transpiles the linked sources.
- `pnpm --filter @nexestra/server build` bundles with esbuild, inlining the
  workspace packages and leaving `hono`, `@hono/node-server`, `ws` and `zod`
  external.
- There is no per-library build step, so nothing can go stale.

---

## 2. Domain model (`packages/core/src/domain`)

One file per entity, all exported from `src/index.ts`:

| File | Exports |
|------|---------|
| `common.ts` | `IdSchema`, `TimestampSchema`, `EntityBaseSchema`, `HarnessIdSchema`, `SandboxLevelSchema`, `ReasoningLevelSchema`, `RunKindSchema`, `McpServerRefSchema`, `UsageSchema`, `JsonSchemaSchema` |
| `workspace.ts` | `Workspace`, `WorkspaceSettings` (default harness/model/sandbox, concurrency, budget, auto-merge) |
| `thread.ts` | `Thread`, `ThreadPhase` (`intake → … → done \| blocked \| cancelled`), `ACTIVE_THREAD_PHASES` |
| `message.ts` | `Message`, `MessageRole`, `MessageReference`, `MessageToolCall`, `MessageAttachment` (the inline "agent response / artifact" card: `artifact` / `plan_preview` / `diff` / `test_report`) |
| `spec.ts` | `Spec`, `SpecScope`, `AcceptanceCriterion`, `Verification` (discriminated union: `command` / `test` / `manual_review`), `OpenQuestion`, `Decision` |
| `plan.ts` | `Plan`, `PlanEdge`, `findPlanCycle()` |
| `task.ts` | `Task`, `TaskStatus`, `HarnessConfig`, `BoardColumn` + `boardColumnForStatus()` / `statusForBoardColumn()` |
| `run.ts` | `Run`, `RunStatus`, `RunEvent` (append-only row: `seq`, `type`, `payload`) |
| `artifact.ts` | `Artifact`, `ArtifactKind` |
| `approval.ts` | `Approval`, `ApprovalKind`, `ApprovalStatus` |
| `memory.ts` | `Memory`, `MemoryType`, `MemoryLink` + `MemoryLinkType`, `MemorySource` |

`harness.ts` holds the adapter contract verbatim from PLAN.md §5:
`HarnessEventSchema` (12 variants), `RunSpecSchema`, `HarnessInfoSchema`,
`PreparedRunSchema`, `RunControlSchema` and the `HarnessAdapter` interface.

`api.ts` holds what crosses the wire: `HealthResponse`, `ServerFrame` /
`ClientFrame` for the WebSocket, and `FileNode` / `FileContent` for the mocked
worktree shown in the Editor surface.

Import direction is one-way (`domain/common.ts → harness.ts → domain/run.ts`)
so there are no module cycles at zod-evaluation time.

---

## 3. How data flows in M0

```
packages/core/src/mock/index.ts          fixtures, parsed through the schemas
        │                                 at module load (drift fails loudly)
        ▼
apps/server  GET /api/mock/*             Hono handlers slice the fixtures
        │
        ▼  (Vite proxies /api → 127.0.0.1:4242 in dev)
apps/web  src/lib/api.ts                 TanStack Query + zod re-validation
        │
        ▼
surfaces/{chat,board,editor,memory}      render; local edits live in Zustand
```

Two deliberate properties:

1. **The web app never imports the mock module directly.** It goes through HTTP,
   so M1 can swap the handlers for projection reads without touching the UI.
2. **Responses are validated on both ends.** The server parses the fixtures at
   startup; the client re-parses each response with the same schema. A schema
   change that breaks the wire format fails immediately instead of rendering
   `undefined`.

Local, session-only state lives in `apps/web/src/lib/store.ts` (Zustand):
theme, selected task / memory, open file, board drag overrides, composer
messages typed in this session, palette open state. None of it is persisted
except the theme.

### Endpoints

| Route | Returns |
|-------|---------|
| `GET /api/health` | `{ ok: true, version }` |
| `GET /api/mock` | Everything, as one bundle |
| `GET /api/mock/workspaces[/:id]` | Workspaces |
| `GET /api/mock/threads?workspaceId=` | Threads |
| `GET /api/mock/threads/:id/messages\|spec\|plan` | Thread detail |
| `GET /api/mock/tasks?threadId=` | Tasks |
| `GET /api/mock/runs?threadId=`, `…/runs/:id/events` | Runs and their events |
| `GET /api/mock/artifacts?threadId=` | Artifacts |
| `GET /api/mock/memories?workspaceId=` | Memory graph nodes |
| `GET /api/mock/approvals?workspaceId=&status=` | Approval queue |
| `GET /api/mock/files`, `…/files/content?path=` | Mock worktree tree / file |
| `GET /api/mock/terminal` | Mock run output for the xterm pane |
| `GET /api/mock/harnesses` | Detected-harness placeholders for Settings |
| `ws://…/ws` | Accepts a connection, sends `{type:"hello"}`, replies to `ping` |

---

## 4. Web app structure

```
apps/web/src
  main.tsx              QueryClientProvider + RouterProvider, applies the theme
  router.tsx            code-based TanStack Router route tree
  app.css               layout for the shell and the four surfaces
  shell/
    AppShell.tsx        rail | navigation | content, mounts keyboard + palette
    WorkspaceRail.tsx   48px workspace rail
    NavigationPanel.tsx THREADS list, divider, SURFACES checkboxes, Settings
    SurfaceLayout.tsx   main | sidebar (280px) frame used by every surface
    surfaces.ts         surface descriptors and their route paths
    useShellKeyboard.ts ⌘1..⌘4, ⌘/, ⌘K, ⌘,
    CommandPalette.tsx  ⌘K palette
  surfaces/chat|board|editor|memory
  settings/SettingsSurface.tsx
  lib/{api,store,format}.ts
```

Routes:

```
/                                            → redirect to the first thread's chat
/w/$workspaceId/t/$threadId/chat             surface 1
/w/$workspaceId/t/$threadId/board            surface 2
/w/$workspaceId/t/$threadId/editor           surface 3
/w/$workspaceId/t/$threadId/memory           surface 4
/settings
```

Layout is `react-resizable-panels` v4 (`Group` / `Panel` / `Separator`). The
navigation (260px) and sidebar (280px) panels declare explicit `px` sizes and
`groupResizeBehavior="preserve-pixel-size"`, so window resizing only changes
the main pane — matching the wireframe proportions.

### Surface implementations

| Surface | Main | Sidebar | Libraries |
|---------|------|---------|-----------|
| Chat | Message timeline (Master / User / System), inline agent-response cards for plan previews, diffs and test reports, composer with `@agent #ref /command` hints | Approval queue, Requirements (spec scope + constraints), Decisions, References | — |
| Task Board | TODO / IN PROGRESS / DONE columns; REVIEW and BLOCKED render only when a task is in them; drag between columns | Title, assigned agent, status, summary, references, acceptance criteria | `@dnd-kit/core` |
| Editor | File tree of the mock worktree, code editor, terminal pane | Active agent, current task, progress bar, artifacts, `[View changes]` | `@uiw/react-codemirror`, `@xterm/xterm` |
| Memory Graph | Nodes coloured by `Memory.type`, typed edges, dagre top-down layout, per-type filter legend | Selected memory, content, incoming/outgoing links, source, `[Open source]` / `[Edit memory]` | `@xyflow/react`, `@dagrejs/dagre` |

---

## 5. What is mocked

Everything behind the UI. Specifically:

- **All entity data** comes from `packages/core/src/mock`: one workspace, two
  threads (`Build agent app`, `Research workflow`), one frozen spec with four
  acceptance criteria, one plan with six tasks and eight dependency edges, five
  runs, five run events, four artifacts, two pending approvals, nine messages
  and sixteen memories with typed links.
- **The Editor file tree, file contents and terminal output** are fixtures, not
  a real worktree. The code shown is the `HarnessAdapter` interface.
- **Harness detection** in Settings is a fixture; nothing shells out to `codex`
  or `opencode`.
- **Every action button** (`Approve`, `Reject`, `Dispatch`, `+ Add`,
  `View changes`, `Open source`, `Edit memory`) is inert and says so in its
  tooltip.
- **The WebSocket** accepts connections and answers `ping`, but never pushes run
  events.
- **Board drags and composer messages** mutate Zustand only; a reload discards
  them.

Nothing writes to disk. `~/.nexestra` is not created in M0.

---

## 6. Tooling and quality gates

- TypeScript 5.9, `strict` plus `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`; `moduleResolution: bundler`.
- Biome 2.5 for lint, format and import ordering (`pnpm lint`).
- Vitest 4 (`pnpm test`): `packages/core` parses every fixture through its
  schema and asserts the plan DAG is acyclic and consistent with each task's
  `dependsOn`; `apps/server` exercises the health and mock routes.
- `pnpm typecheck` runs `tsc --noEmit` per package in parallel.
- `pnpm build` produces `apps/web/dist` and `apps/server/dist/index.js`.

---

## 7. Known gaps going into M1

- No persistence: `@nexestra/storage` is a stub, so nothing survives a restart.
- The mock API is read-only; there are no POST/PATCH routes yet.
- The WebSocket has no subscription registry — `subscribe`/`unsubscribe` frames
  are accepted and ignored.
- `apps/web` has no component tests; Playwright coverage is planned for M7.
- The web bundle is a single ~1.5 MB chunk (CodeMirror + xterm + React Flow).
  Code-splitting per surface is worth doing once the surfaces stop changing.
- Editing in the Settings and Task-details sidebars is display-only; the
  controls are wired to local state or no-ops.
