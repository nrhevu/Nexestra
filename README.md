# Nexestra

Nexestra is a control center for agentic work: it turns a vague request into a
spec with acceptance criteria you can actually check, then plans the work and
drives coding harnesses — Codex, OpenCode — until every criterion has been
proved by running it. A configurable Master agent does the research,
clarifying, design, planning and project-memory work; an orchestrator gives each task its own git worktree,
has a *second* harness review the result, runs the acceptance criteria itself,
retries with the failure attached, and stops at a merge you approve. It is
local-first: one Node process on your machine, a browser SPA, a SQLite file, and
nothing else.

Start with [`docs/index.md`](docs/index.md) if you want the guided tour, or
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what exists today.

## Quickstart (60 seconds)

Requirements: **Node >= 24** (developed on 24.19) and **pnpm 11**
(`corepack enable` picks up the pinned `packageManager`).

```bash
pnpm install
pnpm dev
```

Open **<http://localhost:5173>**. The first run creates `~/.nexestra/nexestra.db`
and applies the migrations. It starts empty: add a workspace from the `+` in the
left rail, pointing it at a **git repository** on your machine.

The application never silently substitutes generated demo content or a scripted
model. Without a configured provider, Settings and Chat report that the Master
is not ready while workspace, memory and task-management features remain
available.

Configure the Master from **Settings → Master provider**. Select a built-in or
add a custom provider, choose its authentication mode, paste its API key, load
the provider's model catalogue, and save. Then open **Agents**, create a
Nexestra agent with that provider/model, and select it for the current chat. A
server restart is not required.

| You have | What runs |
|----------|-----------|
| an OpenAI API key | OpenAI Responses with `chat-latest` by default (or select `gpt-5.6`) |
| an Anthropic API key | Anthropic Messages with Claude Opus 5 |
| a compatible endpoint | Add a custom OpenAI Responses, OpenAI Chat Completions or Anthropic Messages provider, then choose a discovered model |
| a trusted no-auth local endpoint | Add a custom provider with `No authentication`; loopback HTTP is allowed |
| `codex` on `PATH`, after `codex login` | Real Codex runs the tasks |
| `opencode` too, after `opencode auth login` | A second real harness can cross-review task results |

Provider keys are sent only to the loopback server and saved in
`~/.nexestra/credentials.json` with current-user-only file permissions. They
never enter SQLite, the append-only event log, or an API response; the browser
receives only a configured/missing boolean. Environment variables remain a
compatibility fallback for older installations, but are not part of the setup
flow.
OpenAI does not expose ChatGPT subscription OAuth for third-party applications,
so Nexestra uses official API credentials rather than pretending that a ChatGPT
web login authorizes API calls. Harness auth is each harness's own business;
selecting a Codex worker agent can use a Codex CLI authenticated by
`codex login`, but that login does not turn the CLI into Nexestra's Master.
`GET /api/harnesses` reports what `discover()` found (for OpenCode that means
`GET /provider` returning at least one connected provider), and
**Settings → Detected harnesses → [Refresh detection]** re-runs it after you
install or authenticate one.

One switch worth knowing:

```bash
NEXESTRA_HARNESSES=codex pnpm dev # one adapter ⇒ no cross-review ⇒ no second model billed
```

## The five surfaces

| # | Surface | What it is |
|---|---------|------------|
| 1 | **Workspace / Chat** | The conversation with the Master, streaming live: clarifying questions, the spec as it is written, the plan preview, tool calls, and the orchestrator's progress interleaved by time |
| 2 | **Task Board** | The plan as a kanban — TODO / IN PROGRESS / DONE (plus REVIEW and BLOCKED when occupied) — with the harness, model, attempts, cost and merge state on each card, and `[Start execution]` / `[Pause]` / `[Cancel]` in the header |
| 3 | **Agents** | Reusable project-level profiles. A Nexestra agent selects a Master provider/model for chat; a Codex or OpenCode agent selects the harness/model/instructions used by an assigned task |
| 4 | **Editor / Runs** | One run from three angles: its worktree file tree, a file in CodeMirror, the unified diff against the branch it was cut from, and its event stream in a terminal |
| 5 | **Memory Graph** | What the Master decided and learned, as typed nodes and edges, editable |

Plus **Settings** (`⌘,`): detected harnesses, Master providers and credentials,
defaults, budget, concurrency, theme. `⌘1`…`⌘5` switch surfaces, `⌘/`
focuses the composer, `⌘K` is the command palette.

The approval queue lives in the navigation column with a count badge on the
rail, visible from every surface — a gate blocks a run wherever you happen to be
looking.

## How the loop works

```mermaid
flowchart TD
    U([You]) -->|vague request| M[Master · phase machine in code]
    M -->|ask_user| U
    U -->|answers| M
    M -->|update_spec| S[Spec + acceptance criteria]
    S -->|you approve| F[spec frozen]
    F -->|propose_plan| P[Plan · task DAG]
    P -->|Start execution| O[Orchestrator]

    O -->|ready task| W[git worktree per task]
    W --> X[Execute · Codex or OpenCode]
    X -->|blocking findings| X
    X --> R[Cross-review by the OTHER harness]
    R -->|blocking findings| X
    R --> V[Verify · run each criterion in the worktree]
    V -->|failed, attempts left| X
    V -->|attempts exhausted| RP[replan] --> M
    V -->|passed + evidence artifact| G{{merge approval}}
    G -->|you approve| ML[branch lands on the base branch]

    O -.->|gates: sandbox · permission · spend · merge · manual review| Q[Approval queue]
    Q -.-> U
    ML --> D([Done: every criterion has evidence])

    X -.->|events| E[(append-only event log)]
    V -.->|artifacts| E
    E -.->|/ws| UI[The five surfaces]
```

Two rules hold the whole thing up. The **phase machine is code, not prompt** —
the model only ever sees the tools its current phase allows. And **verification
runs commands**: a criterion passes because the orchestrator executed it in the
worktree and captured the exit code, never because the harness said so.

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXESTRA_PORT` | `4242` | Server port (Vite's proxy target too) |
| `NEXESTRA_HOST` | `127.0.0.1` | Server bind address; only `127.0.0.1`, `localhost` or `::1` is accepted |
| `NEXESTRA_HOME` | `~/.nexestra` | Where `nexestra.db`, `data/` and `worktrees/` live |
| `NEXESTRA_DEV` | unset | `1` forces the redirect-to-Vite behaviour (set by the server's `dev` script) |
| `NEXESTRA_WEB_DEV_URL` | `http://localhost:5173` | Where dev-mode non-API requests are redirected |
| `NEXESTRA_HARNESSES` | all | Comma-separated real adapters to register: `codex`, `opencode` |
| `OPENAI_API_KEY` | unset | Legacy fallback for OpenAI; prefer entering the key in Settings |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | unset | Legacy fallback for Anthropic; prefer entering the key in Settings |
| `NEXESTRA_LIVE_CODEX` | unset | `1` runs the opt-in Codex live tests |
| `NEXESTRA_LIVE_CODEX_MODEL` | adapter default | Model for those |
| `NEXESTRA_LIVE_OPENCODE` | unset | `1` runs the opt-in OpenCode live tests |
| `NEXESTRA_LIVE_OPENCODE_MODEL` | `openai/gpt-5.4-mini` | Model for those |
| `NEXESTRA_E2E_PORT` | `4282` | Port the Playwright suite's server listens on |
| `NEXESTRA_E2E_KEEP` | unset | `1` keeps the scratch home, repo and server log after an e2e run |

## Scripts

| Command | Effect |
|---------|--------|
| `pnpm dev` | Server on `127.0.0.1:4242` + Vite on `127.0.0.1:5173`, both watching |
| `pnpm build` | `vite build` for the SPA, an esbuild bundle for the server |
| `pnpm start` | Run the built server, serving the built SPA from `4242` |
| `pnpm test` | Vitest across every package — unit, contract and integration |
| `pnpm typecheck` | `tsc --noEmit` in every package, including `e2e` |
| `pnpm lint` / `pnpm lint:fix` | Biome check (lint + format + import order) |
| `pnpm format` | Biome format only |
| `pnpm e2e` | `pnpm build`, then the Playwright suite |
| `pnpm e2e:only` | Skip the build; `pnpm e2e:browsers` installs Chromium; `pnpm e2e:report` opens the last report |
| `pnpm --filter @nexestra/storage db:generate` | Regenerate `drizzle/` **and** re-embed the SQL into `src/migrations.ts` |

`pnpm test` is green on a machine with no Codex, no OpenCode and no API key.
Paid or logged-in live tests remain opt-in behind the variables above.

## Repo layout

```
nexestra/
  apps/
    server/                 # Hono REST + ws WebSocket over the store
      src/routes/           # one file per resource group
      src/master/           # Master runner, provider resolver, host and store
      src/execution/        # the orchestrator wired up: registry, runtime, files
    web/                    # React 19 SPA — the five surfaces
      src/shell/            # rail, navigation, surface frame, keyboard, palette, approvals
      src/surfaces/{chat,board,editor,memory}/
      src/settings/         # the Settings route
      src/lib/              # TanStack Query hooks, the /ws client, Zustand, formatting
  packages/
    core/                   # zod domain schemas, HarnessAdapter contract, events, wire formats
    ui-kit/                 # Slack-inspired components + design tokens
    storage/                # Drizzle schema, event store, commands, replay, seeding
    master/                 # the Master agent: phases, tools, spec + plan (a library)
    orchestrator/           # the dispatch / review / verify loop (a library)
    adapters/codex/         # `codex exec --json`
    adapters/opencode/      # `opencode serve` + SSE
    adapters/fake/          # deterministic test support; never registered in production
  e2e/                      # Playwright, against the built app on a real server
  fixtures/                 # recorded harness output for the contract tests
  docs/                     # see docs/index.md
```

Workspace packages are consumed as TypeScript source (`main: ./src/index.ts`).
Vite aliases them, `tsx` transpiles them for the server in dev, and the
production bundle inlines them with esbuild — so there is no library build step
to keep in sync.

## Storage

```
~/.nexestra/            # NEXESTRA_HOME overrides this
  nexestra.db           # SQLite (WAL); projections + the append-only event log
  credentials.json      # Master provider keys, mode 0600; never returned by the API
  data/                 # artifact bytes: diffs, harness logs, verification evidence
  worktrees/            # <threadId>/<taskId> — one git worktree per task
```

Every write goes through a command in `@nexestra/storage` that stores the row
**and** appends its event in the same transaction, so the projection tables can
always be rebuilt from `events` (`rebuildProjections(store, threadId)`).
Migrations are applied at startup from the array embedded in
`packages/storage/src/migrations.ts`.

## Documentation

- [`docs/index.md`](docs/index.md) — reading order for everything below
- [`docs/PLAN.md`](docs/PLAN.md) — the original plan, with a status section on
  what actually landed
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the implemented system: event
  catalogue, route list, WebSocket protocol
- [`docs/master.md`](docs/master.md) · [`docs/orchestrator.md`](docs/orchestrator.md)
  — the two libraries in depth
- [`docs/harness-protocols.md`](docs/harness-protocols.md) ·
  [`docs/adapters/codex.md`](docs/adapters/codex.md) ·
  [`docs/adapters/opencode.md`](docs/adapters/opencode.md) — the wire protocols
- [`docs/testing.md`](docs/testing.md) — the test pyramid and how to record a fixture
- [`docs/adr/`](docs/adr/) — one record per architectural decision
- [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CLAUDE.md`](CLAUDE.md)

## Current limitations

- **`pause()` does not suspend a live run.** It stops dispatching; runs already
  in flight finish. Suspending mid-run needs `codex app-server`, which the Codex
  adapter does not use.
- **Cost is often `$0.00`.** Pricing keys on the model name, so a task that
  leaves `model` unset — using the harness's own default — is priced at zero
  even though tokens were spent. Set a model to get a number.
- **`gpt-5.1-codex` is not a safe default for every account.** It is what
  `AppSettings.defaultModel` says, but a Codex CLI signed in with a ChatGPT
  account rejects it with a 400. Leaving the model unset works everywhere.
- **A Master provider is required for agentic planning.** With no usable saved
  credential (or a deliberate no-auth endpoint), the runtime reports
  `configuration required` and does
  not fabricate a plan.
- **Provider model discovery follows the selected wire protocol.** It reads
  OpenAI-compatible `GET /models` or Anthropic `GET /v1/models`. A provider
  with a proprietary catalogue can still use an exact model id entered during
  setup.
- **Usage events are treated as increments.** A harness reporting cumulative
  totals per turn would over-count; Codex emits one per turn, so this is correct
  today and worth revisiting per adapter.
- **The budget warning does not suspend.** 80% raises an approval and the loop
  keeps going; only 100% pauses.
- **One process owns the store.** The approval gate waits on the in-process
  event fan-out, so a second process resolving an approval in the same SQLite
  file would not release the waiter.
- **A restart drops live sessions.** State is rebuilt from `master_state` on the
  next send, but a turn that was in flight is lost rather than resumed.
- **Merge is a plain `git merge`.** No rebase strategy, no auto-resolution; the
  base branch must be checked out and clean or the merge is refused and turned
  into an approval.
- **Worktrees accumulate.** `recover()` prunes trees no live task claims, but
  nothing cleans up after a thread that finishes normally.
- **The event log is never pruned**, and the web bundle is still a single large
  chunk.

The authoritative lists are [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11
and [`docs/orchestrator.md`](docs/orchestrator.md) §9.
