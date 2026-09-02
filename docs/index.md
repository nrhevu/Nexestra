# Documentation index

Nexestra's docs are written to be read in an order. Every file says which
milestone it describes and, where it matters, what it does **not** yet cover.

## Start here

| # | Read | Why |
|---|------|-----|
| 1 | [`../README.md`](../README.md) | What Nexestra is, a 60-second quickstart, the four surfaces, the env vars and the scripts |
| 2 | [`PLAN.md`](PLAN.md) §0 | The status section: which milestones landed, with commit ranges and evidence, and which §1 decisions changed in practice |
| 3 | [`ARCHITECTURE.md`](ARCHITECTURE.md) | The implemented system — package map, domain model, storage, event catalogue, the full route list, the WebSocket protocol, and §11's known gaps |

After those three you can find your way around the repository. Everything below
is depth on one part of it.

## By what you are doing

### Changing the domain model, the API or the wire format

1. [`ARCHITECTURE.md`](ARCHITECTURE.md) §2 (domain model), §3.5 (event
   catalogue), §4 (HTTP API), §5 (`/ws`).
2. [`adr/0005`](adr/0005-event-sourced-store-with-projections.md) — why every
   write is a row **and** an event, and the two deliberate exceptions.
3. [`adr/0006`](adr/0006-embedded-numbered-migrations.md) — why migrations are
   numbered, generated and embedded, and why you never edit an applied one.
4. [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — the conventions and the gates.

### Working on the Master agent

1. [`master.md`](master.md) — the phases, the tool surface per phase, the three
   seams (`LlmClient` / `MasterHost` / `MasterStore`), the model configuration
   and §10's known gaps.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) §6 — how `apps/server` fills those seams
   in: `MasterRunner`, `ServerMasterHost`, `StorageMasterStore`, and which model
   client starts.
3. [`adr/0013`](adr/0013-phase-machine-outside-the-llm.md) and
   [`adr/0014`](adr/0014-strict-tools-instead-of-structured-outputs.md) — why
   the process lives in code and the schemas are strict tools.
4. [`adr/0020`](adr/0020-production-master-provider-registry.md) — OpenAI,
   Anthropic and custom provider resolution, secrets and the no-fallback rule.
5. [`adr/0022`](adr/0022-local-provider-credential-store.md) — write-only
   provider credentials configured in the app and stored outside SQLite.

### Working on the orchestration loop

1. [`orchestrator.md`](orchestrator.md) — the three state machines, the loop
   step by step, the configuration table, `MasterBridge` / `ExecutionHost`, the
   artifact and approval conventions, and §9's known gaps.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) §10 — the server's execution runtime:
   the harness registry, the bridge, recovery and merging.
3. [`adr/0011`](adr/0011-one-git-worktree-per-task.md),
   [`adr/0015`](adr/0015-cross-review-by-a-different-harness.md),
   [`adr/0016`](adr/0016-verification-runs-commands-not-claims.md),
   [`adr/0017`](adr/0017-approval-gates-and-budget-rules.md).

### Working on a harness adapter

1. [`harness-protocols.md`](harness-protocols.md) — the raw, **recorded**
   reference: exactly what `codex exec --json` and `opencode serve` emit, with
   the launch details that bite. Read this before either adapter doc.
2. [`adapters/codex.md`](adapters/codex.md) and
   [`adapters/opencode.md`](adapters/opencode.md) — the public API, the options,
   the event mapping and the limitations of each.
3. [`testing.md`](testing.md) §4 — how to record a new fixture and why the
   `*.meta.json` beside it is not optional.
4. [`adr/0008`](adr/0008-harness-adapter-abstraction.md),
   [`adr/0009`](adr/0009-drive-codex-with-exec-json.md),
   [`adr/0010`](adr/0010-drive-opencode-with-serve-and-sse-over-fetch.md).

### Working on the web app

1. [`ARCHITECTURE.md`](ARCHITECTURE.md) §7 (how data flows, the web data layer,
   which interactions persist) and §8 (the file structure, routes and the
   per-surface breakdown).
2. [`adr/0021`](adr/0021-slack-inspired-project-workspace.md) — the current
   Slack-inspired shell and its interaction rules.
3. [`PLAN.md`](PLAN.md) §7 — the original terminal wireframe, retained as
   historical context.

### Writing or running tests

1. [`testing.md`](testing.md) — the pyramid, test-only substitutes, the
   credential-free production e2e suite, fixture recording and live tests.
2. [`adr/0018`](adr/0018-fake-harness-for-dev-and-tests.md) and
   [`adr/0019`](adr/0019-demo-llm-client-without-an-api-key.md) — the two
   substitutes that make `pnpm test` runnable with no accounts.

### Automating with an AI coding agent

[`../CLAUDE.md`](../CLAUDE.md) — the short version: commands, package map,
gates, where the contracts live, and the rules that are not negotiable.

## Every file

| File | Milestone it describes | Contents |
|------|------------------------|----------|
| [`PLAN.md`](PLAN.md) | M0–M7 | The original plan (Vietnamese), with a status section at the top written after the fact |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | M6, amended M8 | The implemented system, end to end |
| [`master.md`](master.md) | M2, wired in M3 | `@nexestra/master` |
| [`orchestrator.md`](orchestrator.md) | M5, wired in M6 | `@nexestra/orchestrator` |
| [`harness-protocols.md`](harness-protocols.md) | M4/M5 groundwork | Recorded reference for Codex 0.148.0 and OpenCode 1.18.25 |
| [`adapters/codex.md`](adapters/codex.md) | M4 | `@nexestra/adapter-codex` |
| [`adapters/opencode.md`](adapters/opencode.md) | M5 | `@nexestra/adapter-opencode` |
| [`testing.md`](testing.md) | M7, amended M8 | Test pyramid, test doubles, fixtures, e2e, live tests and gates |
| [`adr/`](adr/) | all | 21 decision records — see [`adr/0000-index.md`](adr/0000-index.md) |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | — | Conventions and workflow |
| [`../CLAUDE.md`](../CLAUDE.md) | — | Orientation for AI coding agents |

## A note on staleness

These files were written milestone by milestone, and each one is accurate as of
the milestone in its header. When two disagree, the more recent milestone wins:
`ARCHITECTURE.md` (M6) over `master.md` §10 (M2/M3), and `PLAN.md` §0 over the
plan text below it. `PLAN.md` §0.2 lists the decisions that changed.
