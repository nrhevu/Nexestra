# Nexestra

Control center for agentic work: turn a vague request into a clear spec, then
organise and supervise several coding harnesses (Codex, OpenCode) until the
result has been verified.

Local-first: one Node server on your machine plus a SPA in the browser. See
[`docs/PLAN.md`](docs/PLAN.md) for the full plan and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what exists today.

**Current milestone: M6 — the loop is closed.** A vague sentence becomes
clarifying questions, a spec with verifiable acceptance criteria, an approved
plan, real harness runs in real git worktrees, a cross-review by a second
harness, acceptance criteria proved by *running* them, and a merge you approve
— all of it streaming into the four surfaces as it happens.

## Requirements

- Node >= 24 (developed on 24.19)
- pnpm 11 (`corepack enable` picks up the pinned `packageManager`)

## Getting started

```bash
pnpm install
pnpm dev
```

Then open **http://localhost:5173**.

The first run creates `~/.nexestra/nexestra.db` and applies the migrations. It
starts empty, so either add a workspace from the `+` in the left rail (point it
at a git repository on your machine), or start once with demo content:

```bash
NEXESTRA_SEED_MOCK=1 pnpm dev        # or: pnpm start --seed-mock
```

Seeding is idempotent — it does nothing once a workspace exists.

### Running work without spending anything

Nexestra drives real coding harnesses, which cost real money. To see the whole
loop first — plan, runs, worktrees, diffs, review, verification, approvals,
merge — start it with the **simulated harness**:

```bash
NEXESTRA_FAKE_HARNESS=1 pnpm dev
```

It stands in for `codex` and `opencode`, writes real files into the real
worktrees (so the diff, the commit and the verification commands all see a tree
that genuinely changed) and spawns nothing. `GET /api/harnesses` and the
Settings surface say so rather than pretending. The same switch lives in
**Settings → Defaults → Simulated harness**, which survives a restart.

Then, when you want the real thing:

| You have | What runs |
|----------|-----------|
| nothing | The demo Master (a script) plans; the simulated harness "executes" |
| `codex` on `PATH` | Real Codex runs, still with the demo Master |
| `ANTHROPIC_API_KEY` set | Claude Opus 5 is the Master |
| both + `opencode` | The full loop: Opus plans, Codex executes, OpenCode cross-reviews |

`ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is read from the server's
environment and never reaches the browser — only *whether* one is set does.
`NEXESTRA_MASTER_LLM=demo|anthropic` overrides the choice.

Harness auth is each harness's own business: `codex login` and `opencode auth
login`. `GET /api/harnesses` reports what `discover()` found, and
**Settings → Detected harnesses → [Refresh detection]** re-runs it after you
install or authenticate one.

### Running one task, deliberately cheaply

The cross-review pass picks a harness *other* than the executor, so a process
with one adapter reviews nothing and spends nothing on a second model:

```bash
NEXESTRA_HARNESSES=codex pnpm dev
```

### Starting execution

Approving the spec gets you a plan on the **Task Board**. `[Start execution]`
in its header accepts the plan and hands it to the orchestrator; from there the
board is live (spinners, attempts, cost, merge state) and `[Pause]` /
`[Cancel]` do what they say. Per task, the sidebar has `[Dispatch]` (run it now,
out of band of the scheduler) and `[Verify]` (run its acceptance criteria).

Anything that needs you — a sandbox escalation, 80% of the budget, a merge, a
manual-review criterion, a harness asking permission mid-run — appears in the
**approval queue** in the navigation column, with a count badge on the rail. It
is visible from every surface, because a gate blocks a run wherever you happen
to be looking.

`pnpm dev` runs two processes concurrently:

| Process | Port | What it does |
|---------|------|--------------|
| `@nexestra/server` (Hono + `ws` via `tsx watch`) | `127.0.0.1:4242` | `/api/health`, the `/api/*` REST surface, `ws://…/ws` |
| `@nexestra/web` (Vite) | `127.0.0.1:5173` | The SPA; proxies `/api` and `/ws` to 4242 |

In dev, `http://localhost:4242/` redirects any non-API request to the Vite
server, so the port from PLAN.md §1 still gets you to the UI.

Quick checks:

```bash
curl http://127.0.0.1:4242/api/health                      # {"ok":true,"version":"0.0.0-m1"}
curl http://127.0.0.1:4242/api/workspaces
curl http://127.0.0.1:4242/api/harnesses                   # what discover() found
curl 'http://127.0.0.1:5173/api/tasks?threadId=th_agent_app'  # proxied through Vite
```

Running a second checkout side by side? Give it its own port pair and database:

```bash
NEXESTRA_HOME=/tmp/nexestra-alt NEXESTRA_PORT=4252 pnpm --filter @nexestra/server dev
NEXESTRA_PORT=4252 pnpm --filter @nexestra/web exec vite --port 5183 --strictPort
```

## Production-ish run

```bash
pnpm build     # apps/web/dist  +  apps/server/dist/index.js
pnpm start     # serves apps/web/dist from http://127.0.0.1:4242
```

In this mode the server serves `apps/web/dist` statically with an
`index.html` fallback, so client-side routes survive a reload.

## Storage

```
~/.nexestra/            # NEXESTRA_HOME overrides this
  nexestra.db           # SQLite (WAL); projections + the append-only event log
  data/                 # artifact bytes: diffs, harness logs, verification evidence
  worktrees/            # <threadId>/<taskId> — one git worktree per task
```

Every write goes through a command in `@nexestra/storage` that stores the row
**and** appends its event in the same transaction, so the projection tables can
always be rebuilt from `events` (`rebuildProjections(store, threadId)`).
Migrations are applied automatically at startup.

To change the schema, edit `packages/storage/src/schema.ts` and run:

```bash
pnpm --filter @nexestra/storage db:generate
```

That regenerates `packages/storage/drizzle/` with drizzle-kit and re-embeds the
SQL into `src/migrations.ts` — which is what the runtime applies, so the
esbuild server bundle needs no migration files on disk. Both are committed, and
a test fails if they drift.

The event catalogue, the full route list and the WebSocket protocol are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Scripts

| Command | Effect |
|---------|--------|
| `pnpm dev` | Server (4242) + Vite (5173), both watching |
| `pnpm build` | `vite build` for the web app, esbuild bundle for the server |
| `pnpm start` | Run the built server, serving the built SPA |
| `pnpm test` | Vitest across every package |
| `pnpm lint` / `pnpm lint:fix` | Biome check (lint + format + import order) |
| `pnpm typecheck` | `tsc --noEmit` in every package |

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXESTRA_PORT` | `4242` | Server port |
| `NEXESTRA_HOST` | `127.0.0.1` | Server bind address (keep it local) |
| `NEXESTRA_WEB_DEV_URL` | `http://localhost:5173` | Where dev-mode requests are redirected |
| `NEXESTRA_DEV` | unset | Set to `1` to force the redirect-to-Vite behaviour |
| `NEXESTRA_HOME` | `~/.nexestra` | Where `nexestra.db` and `data/` (artifact bytes) live |
| `NEXESTRA_SEED_MOCK` | unset | Set to `1` to load the demo fixtures into an empty database (same as `--seed-mock`) |
| `NEXESTRA_FAKE_HARNESS` | unset | Set to `1` to replace every harness with the scripted stand-in — the whole loop, no quota |
| `NEXESTRA_HARNESSES` | all | Comma-separated ids to register (`codex`, `opencode`, `fake`). One adapter means no cross-review |
| `NEXESTRA_MASTER_LLM` | auto | `demo` or `anthropic`; otherwise decided by whether an API key is present |
| `ANTHROPIC_API_KEY` | unset | The Master's key. Never sent to the browser |

## Layout

```
nexestra/
  apps/
    server/                 # Hono REST API over the store + ws WebSocket
      src/master/           # the Master runtime: runner, host, store, demo model
      src/execution/        # the orchestrator wired up: adapters, bridge, worktree files
    web/                    # React 19 SPA — the four surfaces
      src/shell/            # rail, navigation, surface frame, keyboard, palette
      src/surfaces/chat/    # 1. Workspace / Chat
      src/surfaces/board/   # 2. Task Board
      src/surfaces/editor/  # 3. Editor / Agent workspace
      src/surfaces/memory/  # 4. Memory graph
      src/settings/         # Settings route
      src/lib/              # API + mutation hooks (TanStack Query), /ws client, Zustand, formatting
  packages/
    core/                   # zod domain schemas, HarnessAdapter contract, mock data
    ui-kit/                 # terminal-like components + design tokens
    storage/                # Drizzle schema, event store, commands, replay, seeding
    master/                 # Master agent: phases, tools, spec + plan
    orchestrator/           # dispatch / review / verify loop
    adapters/codex/         # `codex exec --json`
    adapters/opencode/      # `opencode serve` + SSE
  docs/
  fixtures/                 # recorded harness output for contract tests
```

Workspace packages are consumed as TypeScript source (`main: ./src/index.ts`).
Vite aliases them, `tsx` transpiles them for the server in dev, and the
production server build inlines them with esbuild — so there is no library
build step to keep in sync.

## Keyboard

| Keys | Action |
|------|--------|
| `⌘1` … `⌘4` | Switch surface (Chat, Task Board, Editor, Memory Graph) |
| `⌘/` | Jump to Chat and focus the composer |
| `⌘K` | Command palette |
| `⌘,` | Settings |

## Theme

Dark by default, light available from **Settings → Appearance**. The choice is
stored in `localStorage` and applied as `data-theme` on `<html>`; every colour
is a CSS variable defined in `packages/ui-kit/src/styles.css`.
