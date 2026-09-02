# AGENTS.md — orientation for AI coding agents

Nexestra is a local-first control center that plans agentic work and drives
coding harnesses until acceptance criteria are proved by running them. One Node
server (`127.0.0.1:4242`), one React SPA, one SQLite file.

Read [`docs/index.md`](docs/index.md) for the guided tour and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the conventions in full. This file is
the short version.

## Commands

```bash
pnpm install                 # Node >= 24, pnpm 11 (corepack enable)
pnpm dev                     # server :4242 + Vite :5173, both watching
pnpm lint                    # biome check .          ← fastest gate
pnpm typecheck               # tsc --noEmit everywhere
pnpm test                    # vitest, every package, in parallel
pnpm build                   # apps/web/dist + apps/server/dist/index.js
pnpm e2e                     # build, then Playwright (needs pnpm e2e:browsers once)

pnpm --filter @nexestra/<name> test          # one package
pnpm --filter @nexestra/storage db:generate  # after editing storage/src/schema.ts
```

All four gates must be green before a merge. `pnpm test` must stay green with no
Codex, no OpenCode and no saved provider credential; paid or logged-in live
tests are opt-in and skipped by default.

Useful switches while developing: `NEXESTRA_HARNESSES=codex` (one real adapter,
so no cross-review),
`NEXESTRA_HOME=/tmp/…` (a scratch database). Full table in the README.

## Package map

| Package | What it owns |
|---------|--------------|
| `@nexestra/core` (`packages/core`) | **The contracts.** zod domain schemas, the `HarnessAdapter` / `HarnessEvent` / `RunSpec` contract, the event catalogue, the REST bodies, the `/ws` frames, the price table |
| `@nexestra/storage` | Drizzle schema, migrations, `EventStore`, the `NexestraStore` command surface, replay, seeding |
| `@nexestra/master` | The Master agent as a **library**: phase machine, per-phase tools, spec + plan. No HTTP, no database, no processes |
| `@nexestra/orchestrator` | The dispatch / review / verify loop as a **library**: scheduler, worktrees, retry, replan, approvals, budget, merge, recovery |
| `@nexestra/adapter-codex` | `codex exec --json` → `HarnessEvent`, plus the shared git worktree primitives |
| `@nexestra/adapter-opencode` | `opencode serve` + SSE → `HarnessEvent`, over plain `fetch` |
| `@nexestra/adapter-fake` | Test-only scripted adapter; never registered by production |
| `@nexestra/ui-kit` | Terminal-like components + the CSS-variable design tokens |
| `@nexestra/server` (`apps/server`) | Hono REST + `ws`; fills in the Master's seams (`src/master/`) and the loop's seams (`src/execution/`) |
| `@nexestra/web` (`apps/web`) | React 19 SPA: shell, four surfaces, settings |
| `@nexestra/e2e` (`e2e/`) | Playwright against the built app on a real server |

## Where the contracts live

Look here **before** inventing a type:

| Contract | File |
|----------|------|
| Domain entities | `packages/core/src/domain/*.ts` |
| Harness adapter, `HarnessEvent`, `RunSpec` | `packages/core/src/harness.ts` |
| Persisted event catalogue | `packages/core/src/events.ts` |
| REST request bodies + the error envelope | `packages/core/src/api-http.ts` |
| Execution wire format (`ExecutionStatus`, `OrchestratorProgress`, `RunDiff`) | `packages/core/src/execution.ts` |
| WebSocket frames | `packages/core/src/ws.ts` |
| Master stream payloads | `packages/core/src/master.ts` |
| App settings + defaults | `packages/core/src/domain/settings.ts` |
| `MasterHost` / `MasterStore` / `LlmClient` seams | `packages/master/src/host.ts`, `store.ts`, `llm/types.ts` |
| `MasterBridge` / `ExecutionHost` seams | `packages/orchestrator/src/types.ts`, `apps/server/src/master/execution-host.ts` |
| Store commands | `packages/storage/src/store.ts` |
| Routes | `apps/server/src/routes/*.ts` |

## Rules

**1. `@nexestra/core` changes are additive.** New optional fields, new union
members, new schemas. A required field on an existing entity means a migration,
a replay path and every recorded fixture predating it. Run `pnpm typecheck`
across the workspace immediately after touching `core`.

**2. Migrations are numbered, generated and embedded.** Edit
`packages/storage/src/schema.ts`, then run
`pnpm --filter @nexestra/storage db:generate` — which runs drizzle-kit into
`drizzle/` **and** re-embeds the SQL into `src/migrations.ts` via
`scripts/embed-migrations.mjs`. Commit both. Never hand-edit
`src/migrations.ts` (it has a generated header) and never edit an applied
migration; add the next number. A test fails if the two copies drift.

**3. Every write is a row and an event, in one transaction.** Go through a
`NexestraStore` command. Entity event payloads carry the **full post-state**, so
replay is an upsert; if you add a column that must survive replay, add it to the
payload. The `master.*` and `orchestrator.*` families are streaming-only and are
skipped by `rebuildProjections`.

**4. The phase machine is code, not prompt.** `nextPhase()` in
`packages/master/src/phase.ts` is pure and guarded, and the model is only ever
sent the tools its current phase allows. Do not move a gate into a prompt. The
orchestrator **never** writes `Thread.phase`; it notifies and the bridge in
`apps/server/src/execution/runtime.ts` translates.

**5. Verification runs commands.** A criterion passes because the orchestrator
executed it in the task's worktree and captured the exit code, with an evidence
artifact to show for it. The harness's `final` message is a log, never proof.

**6. Never fake the thing you are testing, and never require a thing you are
not.** Substitutes go behind an existing seam (`@nexestra/adapter-fake`,
`FakeLlmClient`, `DemoLlmClient`, a temp git repo, a temp `NEXESTRA_HOME`).
Anything that costs money or needs a logged-in CLI is skipped unless its env var
is set.

**7. Adapters are contract-tested against recordings, not against ideas.** New
protocol handling needs a fixture in `fixtures/<harness>/` with a
sibling `*.meta.json` naming the harness version, scrubbed of home directories
and tokens. Unknown events are dropped, not fatal.

**8. Directions that must not be crossed.** `@nexestra/orchestrator` does not
import `@nexestra/master`. `apps/web` does not import `@nexestra/core/mock`; it
speaks HTTP and WebSocket only. Only `packages/storage` touches SQLite.

**9. Style is enforced, not discussed.** Biome (2 spaces, 100 columns, double
quotes, semicolons, trailing commas), `noExplicitAny` and `noUnusedImports` are
errors, `verbatimModuleSyntax` means `import type` for type-only imports, and
relative imports carry the `.js` extension. Vitest globals are off — import
`describe` / `it` / `expect`.

**10. Work on a branch in its own worktree**, `m<milestone>-<topic>`, landed as
`merge: <branch-name>`. Commit as
`git -c user.name=nexestra -c user.email=nexestra@local` with a conventional
subject and, when an AI assistant wrote it, a
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

**11. Documentation is part of the change.** Each doc names the milestone it
describes and keeps an honest "known gaps" section. A new architectural decision
gets an ADR in `docs/adr/` (`NNNN-title.md`; Context / Decision / Consequences /
Status; cite the files that implement it) and a row in
`docs/adr/0000-index.md`.

## Known gaps to not be surprised by

`pause()` does not suspend a live run. Cost reads `$0.00` when a task leaves
`model` unset. A missing Master credential leaves planning explicitly
unconfigured; there is no demo fallback. One process must own the SQLite file,
because the approval gate waits on the in-process
event fan-out. Worktrees accumulate. The event log is never pruned. The
authoritative lists are `docs/ARCHITECTURE.md` §11 and `docs/orchestrator.md`
§9.
