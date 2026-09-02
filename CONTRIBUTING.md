# Contributing to Nexestra

The conventions below are the ones actually used in this repository, not
aspirations. If something here disagrees with the code, the code is the bug
report.

## Setup

```bash
corepack enable      # picks up the pinned packageManager (pnpm 11.19.0)
pnpm install
pnpm dev
```

Node >= 24 is required (`engines` in the root `package.json`).

## The gates

Four commands, in the order that fails fastest:

```bash
pnpm lint        # biome check .
pnpm typecheck   # tsc --noEmit in every package, including e2e
pnpm test        # unit + contract + integration; excludes e2e
pnpm build       # apps/web/dist and apps/server/dist/index.js
```

A fifth is separate on purpose, because it needs a build and a browser:

```bash
pnpm e2e:browsers   # once per machine: playwright install chromium
pnpm e2e            # pnpm build, then Playwright
```

All of them must be green before a merge. `pnpm test` must stay green on a
machine with **no** Codex, **no** OpenCode and **no** `ANTHROPIC_API_KEY` —
that is the rule the whole test pyramid is built on.

### Fast development loop

Keep the inner loop scoped; the full gates are a checkpoint, not a save hook:

```bash
# While editing one package
pnpm exec biome check apps/web/src/surfaces/agents/AgentDialog.tsx
pnpm --filter @nexestra/web typecheck
pnpm --filter @nexestra/web test

# After a coherent code slice
pnpm check:fast       # lint, then full typecheck + Vitest concurrently

# Once before handoff
pnpm check            # check:fast + production build
pnpm e2e:only tests/agents.spec.ts     # if dist is current
```

Use `pnpm e2e:ui` when iterating on browser behaviour: it builds once and keeps
Playwright's UI session available for targeted reruns. Local Playwright runs
fail after 5 seconds per stuck action and do not retry; CI keeps the longer
timeouts and one retry. Set `NEXESTRA_E2E_SLOW=1` locally only when debugging a
deliberately long browser flow.

## Tooling conventions

**pnpm workspaces.** Packages live under `apps/*`, `packages/*`,
`packages/adapters/*` and `e2e`. Run one package's script with
`pnpm --filter @nexestra/<name> <script>`. Every internal package points
`main` / `types` / `exports` at `./src/index.ts` — TypeScript source, not build
output — so there is no library build step. Do not add one.

**Biome 2.5** is lint, format and import ordering in one (`biome.json`). Notable
settings: 2-space indent, 100-column lines, double quotes, semicolons, trailing
commas everywhere, `noExplicitAny` as an **error**, `noUnusedImports` as an
error, `useImportType` as an error. `pnpm lint:fix` applies what it can. Biome
also formats JSON, which includes the generated drizzle snapshots.

**TypeScript 5.9, strict**, plus `noUncheckedIndexedAccess`, `noUnusedLocals`,
`noUnusedParameters` and `verbatimModuleSyntax`, with
`moduleResolution: bundler` (`tsconfig.base.json`). `verbatimModuleSyntax` is
why every type-only import must say `import type`. Relative imports carry the
`.js` extension even though the sources are `.ts`.

**Vitest 4** for everything except the browser. Each package has
`test: vitest run --passWithNoTests`; the root `pnpm test` is
`pnpm -r --parallel test`. Vitest globals are **off** — import `describe`,
`it`, `expect` explicitly.

## Where things belong

| You are adding | It goes in |
|----------------|------------|
| A domain type, an event type, a REST body, a `/ws` frame | `packages/core` — and nowhere else |
| A store command | `packages/storage/src/store.ts`, with its event, in one transaction |
| A route | `apps/server/src/routes/<resource>.ts`, body validated with a `@nexestra/core` schema |
| Master behaviour | `packages/master` if it is model/phase logic, `apps/server/src/master` if it needs the database or the filesystem |
| Loop behaviour | `packages/orchestrator` if it is scheduling/verification, `apps/server/src/execution` if it needs the registry, the bridge or HTTP |
| Harness protocol handling | the adapter package, behind a fixture |

Two directions that must not be crossed: `@nexestra/orchestrator` does **not**
import `@nexestra/master` (it declares the shared interfaces structurally), and
`apps/web` does **not** import `@nexestra/core/mock` — it speaks HTTP and
WebSocket only, re-validating every response with the same schema the server
parsed.

## Changing `@nexestra/core`

`core` is the contract between the server, the browser, the adapters and the
tests. Prefer **additive** changes: new optional fields, new union members, new
schemas. A required field added to an existing entity has to be migrated
([below](#changing-the-database-schema)), replayed and back-filled, and it
breaks every recorded fixture that predates it.

When you do change it, run `pnpm typecheck` across the whole workspace before
anything else — that is the check the shared-source setup exists for.

## Changing the database schema

`packages/storage/src/schema.ts` is the source of truth.

```bash
# 1. edit src/schema.ts
pnpm --filter @nexestra/storage db:generate
# 2. commit BOTH packages/storage/drizzle/** and src/migrations.ts
```

`db:generate` runs drizzle-kit into `drizzle/` **and** re-embeds the statements
into `src/migrations.ts` with `scripts/embed-migrations.mjs`. The runtime applies
the embedded array, because the server ships as a single esbuild bundle where
`drizzle/` does not exist. `migrations.test.ts` fails if the two drift.

Rules:

- Migrations are **numbered and append-only**: `0000_init`,
  `0001_task_merge_state`, `0002_master_runtime`, … Never edit an applied one;
  add the next number.
- Never hand-edit `src/migrations.ts`. It carries a generated header.
- If a new column needs to survive replay, add it to the event payload too —
  entity events carry the **full post-state**, which is what makes
  `rebuildProjections` a plain upsert.

## Tests

The rule: *never fake the thing you are testing, and never require a thing you
are not.* Every external dependency sits behind an interface with a real
implementation and a substitute. See [`docs/testing.md`](docs/testing.md) for
the whole pyramid; the short version:

| Layer | What is real | What stands in |
|-------|--------------|----------------|
| Unit | the function under test | everything else |
| Contract | the adapter's parser | a recorded `fixtures/**` stream |
| Integration | the loop, git, the database, the shell | the harness (`@nexestra/adapter-fake`) and the model (`FakeLlmClient` / `DemoLlmClient`) |
| e2e | the built SPA, the real server, Chromium | the harness and the model, same as above |

Anything that costs money or needs a logged-in CLI is skipped by default and
opts in through an env var (`NEXESTRA_LIVE_CODEX`, `NEXESTRA_LIVE_OPENCODE`,
`ANTHROPIC_API_KEY`). Do not make a paid test run by default.

### Recording a fixture

Contract tests are only worth their weight if the recordings are real.

1. Run the harness by hand, exactly as the adapter would invoke it, and capture
   the raw stream into `fixtures/codex/*.jsonl` or `fixtures/opencode/*.sse`.
2. Write the sibling `*.meta.json`. It is **not optional** — it is what tells
   the next reader which harness version the recording proves anything about.
   Required keys: `harness`, `harnessVersion`, `platform`, `node`, `recordedAt`,
   `scenario`, `argv`, `cwd`, `exitCode`, and `notes` for anything surprising.
3. **Scrub it.** Recordings are committed: no absolute home directories, no
   tokens, no customer code. The convention is `/HOME` for the home directory
   and `/WORK` for the scratch repository root; provider reasoning blobs become
   `<REDACTED>`.
4. The parser tests replay **every** file in the fixture directory, so a new
   recording needs no registration. Add a named assertion only for what is new.
5. If the recording came from a newer harness, bump `TESTED_CODEX_VERSION` (or
   the OpenCode equivalent in `options.ts`) so `discover()` warns about the
   drift honestly.

Full instructions with the exact commands: [`docs/testing.md`](docs/testing.md) §4.

## Branches and worktrees

Work happens on a branch in its **own git worktree**, which is the same
discipline Nexestra imposes on its agents:

```bash
git worktree add .worktrees/<branch-name> -b <branch-name>
cd .worktrees/<branch-name>
pnpm install
```

`.worktrees/` is git-ignored. Branch names in this repository read
`m<milestone>-<topic>` (`m4-codex-adapter`, `m5-opencode-adapter`,
`m6-integration`, `m7-test-infra`, `m7-docs`) and land as an explicit merge
commit titled `merge: <branch-name>` — so `git log --first-parent` reads as a
list of milestones.

Give a second checkout its own port pair and database rather than fighting over
`4242` and `~/.nexestra`:

```bash
NEXESTRA_HOME=/tmp/nexestra-alt NEXESTRA_PORT=4252 pnpm --filter @nexestra/server dev
NEXESTRA_PORT=4252 pnpm --filter @nexestra/web exec vite --port 5183 --strictPort
```

## Commits

Conventional-commit subjects, scoped to the package: `feat(master): …`,
`fix(server): …`, `test(opencode): …`, `docs(orchestrator): …`, `chore: …`,
`style: …`. One logical change per commit; the history is meant to be readable
milestone by milestone.

Commits authored with an AI assistant carry a co-author trailer, and the commit
identity is the project's, not a person's:

```bash
git -c user.name=nexestra -c user.email=nexestra@local commit -m "$(cat <<'EOF'
feat(scope): what changed

Why it changed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

## Documentation

Docs are part of the change, not a follow-up. Each file states the milestone it
describes and keeps an honest "known gaps" section — a limitation named in the
docs is a feature of the docs. New architectural decisions get an ADR in
`docs/adr/` (`NNNN-title.md`, Context / Decision / Consequences / Status, citing
the files that implement it), and are listed in `docs/adr/0000-index.md`.
