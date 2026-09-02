# Testing Nexestra

Milestone M7. Nexestra drives real processes against real repositories, so the
question every layer of this suite answers is the same one: **how much of the
system is really under test, and what stood in for the rest?**

The rule the whole pyramid is built on: *never fake the thing you are testing,
and never require a thing you are not*. `pnpm test` is green on a laptop with
no Codex, no OpenCode and no `ANTHROPIC_API_KEY` — because every external
dependency sits behind an interface with a real implementation and a
substitute, not because the tests avoid the hard parts.

| Seam | Real | Substitute |
|------|------|------------|
| The harnesses | `@nexestra/adapter-codex`, `@nexestra/adapter-opencode` | `@nexestra/adapter-fake` |
| The model | `createAnthropicLlmClient()` (`claude-opus-5`) | `FakeLlmClient` (unit), `DemoLlmClient` (server, e2e) |
| The repository | the user's checkout | `createTempGitRepo()` from `@nexestra/core/testing` |
| The database | `~/.nexestra/nexestra.db` | the same store on a temp `NEXESTRA_HOME` |
| The browser | the user's | Playwright + Chromium, against the built SPA |

---

## 1. The pyramid

### Unit — Vitest, per package

Pure functions and small state machines: the phase machine, the DAG scheduler,
the JSONL splitter, the event mappers, the board column mapping, the React
cards. No processes, no network, no disk beyond a temp directory.

```bash
pnpm test                                  # every package, in parallel
pnpm --filter @nexestra/master test        # one package
pnpm --filter @nexestra/web test           # jsdom + Testing Library
```

### Contract — Vitest, over recorded fixtures

The adapters are tested against **real recorded output** from the harnesses,
not against a hand-written idea of it: every `fixtures/codex/*.jsonl` and
`fixtures/opencode/*.sse` recording is replayed through the parser, and the
tests assert both that the known events map correctly and that an unknown one
is dropped rather than crashing the run (PLAN.md §5, §9). Each recording is
committed with a `*.meta.json` naming the harness version it came from, so a
protocol change shows up as a failing test instead of a runtime surprise.

```bash
pnpm --filter @nexestra/adapter-codex test
pnpm --filter @nexestra/adapter-opencode test
```

### Integration — Vitest, real processes and real git

The orchestrator's tests run the whole loop — schedule, worktree, execute,
cross-review, verify, retry, replan, approvals, budget, merge, recover — over
a temp git repository and a temp store, with `@nexestra/adapter-fake` standing
in for the harnesses. The verification commands are really executed and the
diffs are really `git diff`, because the fake writes real files.

`apps/server` does the same one level up: `createApp(store, { master })` takes
an injected Master runtime, so the routes and the WebSocket are tested against
a scripted model.

```bash
pnpm --filter @nexestra/orchestrator test
pnpm --filter @nexestra/server test
```

### End-to-end — Playwright, one browser against the built app

`e2e/` starts the real server on a scratch `NEXESTRA_HOME`, serving the real
`apps/web/dist`, and drives it in Chromium. No Vite, no mock API, no stubbed
fetch: what the test clicks is what ships.

```bash
pnpm e2e            # build, then run the suite
pnpm e2e:only       # skip the build (the dist is already current)
pnpm e2e:report     # open the HTML report of the last run
```

---

## 2. Running the e2e suite

### First time

```bash
pnpm install
pnpm e2e:browsers   # playwright install chromium — ~100 MB, once per machine
pnpm e2e
```

### What `pnpm e2e` does

1. `pnpm build` — builds `apps/web/dist` and `apps/server/dist`.
2. `e2e/src/global-setup.ts`:
   - creates a scratch `NEXESTRA_HOME` under the system temp directory;
   - creates a throwaway git repository (`createTempGitRepo()`) for a workspace
     to point at;
   - starts the server on **port 4282** with `NEXESTRA_SEED_MOCK=0`, no
     `ANTHROPIC_API_KEY` (so the Master is the deterministic `DemoLlmClient`)
     and `NEXESTRA_FAKE_HARNESS=1`;
   - waits for `GET /api/health`, then writes `e2e/.e2e-state.json` for the
     workers.
3. The specs run in **one worker, serially** — they share one server and one
   SQLite file, and each creates its own workspace and thread over the API so
   they stay independent of each other.
4. `e2e/src/global-teardown.ts` stops the server and deletes everything.
   `NEXESTRA_E2E_KEEP=1` leaves the scratch home, the repository and the server
   log in place for an autopsy.

Failures leave a screenshot; the retry (there is exactly one) leaves a trace:

```bash
pnpm exec playwright show-trace e2e/test-results/<test>/trace.zip
```

### The specs

| File | Covers | Status |
|------|--------|--------|
| `tests/shell.spec.ts` | shell chrome, the four surfaces by mouse and by `⌘1..⌘4`, deep-link reload | passing |
| `tests/workspace.spec.ts` | adding a workspace pointed at a real git repo, creating a thread, rejecting a non-repo path | passing |
| `tests/chat.spec.ts` | vague message → question card → answers → spec card → approve → plan → tasks on the board | passing |
| `tests/board.spec.ts` | dragging a card between columns, persistence across reload, selection | passing |
| `tests/settings.spec.ts` | the Master runtime it actually started with, the harness table, saving a default | passing |
| `tests/execution.spec.ts` | a task run to `done` on the fake harness, the Editor showing the worktree, an approval unblocking a run | **skipped — M6** |

`execution.spec.ts` is skipped for two reasons, both of which name themselves
in the skip message:

1. `apps/server` does not read `NEXESTRA_FAKE_HARNESS` yet — the orchestrator
   is not wired into the server on this branch. Global setup greps the server
   sources for the variable and records the answer, so the gate opens on its
   own when the wiring lands.
2. There is still no way to *dispatch* a task from a test: there is no
   `POST /api/tasks/:id/dispatch`, and `DemoLlmClient` has no `executing`
   phase. `startExecution()` in that file is the one place to point at whatever
   M6 exposes; then set `NEXESTRA_E2E_EXECUTION=1` and delete the second gate.

### Environment

| Variable | Effect |
|----------|--------|
| `NEXESTRA_E2E_PORT` | server port for the suite (default `4282`) |
| `NEXESTRA_E2E_KEEP=1` | keep the scratch home, repo and server log after the run |
| `NEXESTRA_E2E_EXECUTION=1` | opt in to the execution specs once M6 provides a dispatch trigger |
| `CI` | adds the GitHub reporter and forbids `test.only` |

> The suite runs the server from source under `tsx`, not from
> `apps/server/dist/index.js`. The esbuild bundle keeps `better-sqlite3`
> external, and under pnpm's isolated `node_modules` that specifier is not
> resolvable from `apps/server/dist` — `pnpm start` fails the same way. Switch
> `e2e/src/server.ts` to the bundle once that is fixed.

---

## 3. The fake harness

`@nexestra/adapter-fake` is a complete `HarnessAdapter` (PLAN.md §5) with
nothing behind it. It is what makes the orchestrator loop, the server and the
e2e suite runnable on a machine with no Codex and no OpenCode — and what makes
the demo mode of the product possible at all.

```ts
import { createFakeAdapter } from "@nexestra/adapter-fake";

const fake = createFakeAdapter({ id: "codex", delayMs: 20 });
const orchestrator = createOrchestrator({ store, adapters: { codex: fake }, config });
```

`HarnessId` has no `fake` member — the fake *stands in for* a harness rather
than being one — so it impersonates `codex` by default and takes the id it
should answer to. `discover()` reports version `0.0.0-fake`, model
`fake-model`, `authOk: true` and a warning saying what it is.

### Scenarios

A run's behaviour is a **scenario**, not an event list:

| Scenario | What the run does |
|----------|-------------------|
| `success` | `started → assistant_text → tool_call/tool_result → file_changed → command → usage → final → ended(0)`, and really writes the files the instructions name into `spec.cwd` |
| `retryable_failure_then_success` | attempt 1 ends `error{retryable:true}` + `ended(1)`; attempt 2 is `success` |
| `fatal_failure` | `error{retryable:false}` + `ended(1)` — nothing a retry can fix |
| `permission_request` | emits `permission_request` and **blocks** until `control(runId, {action:"answer_permission"})`; approval writes the files and ends 0, rejection ends 1 with nothing written |
| `slow` | streams progress over `slowMs` (default 3 s) and stops the moment it is cancelled |
| `review_with_findings` | a `kind:"review"` run whose `final.structured` carries blocking findings |
| `review_clean` | a review with no findings — the default for `kind:"review"` |

The scenario for a run is resolved in this order: `options.scenario`,
`options.scenarioFor(spec)`, a marker in the run's instructions,
`options.defaultScenario`, then the run kind (`review` → `review_clean`,
everything else → `success`).

The instruction marker is what lets a *task description* ask for a failure,
with no test code involved:

```
Create `src/hello.ts`. [scenario: retryable_failure_then_success]
```

`[scenario: x]`, `nexestra-scenario=x` and a bare `x` anywhere in the text all
work.

### Files it writes

`success` writes the files the instructions name in backticks (falling back to
bare paths in prose, and to a single `nexestra-fake/<taskId>.md` when neither
is present). Content is deterministic and valid for the extension, so
`git diff`, the Editor surface and the acceptance-criteria commands all see a
real change. Absolute paths, `..` traversal and project config files
(`package.json`, `tsconfig.json`, …) are refused. Override with
`filesFor(spec)`.

Ids, token counts and costs are deterministic: the same task, kind and attempt
always produce the same `sessionRef` (`fake_<taskId>_<kind>_<attempt>`), the
same call ids and the same `usage.costUSD`.

### The scripted form

When a unit test wants to spell out the exact events, `createFakeHarnessAdapter()`
takes a script per run — that is the older, lower-level API the orchestrator
tests use, and it still lives behind `packages/orchestrator/src/fake-adapter.ts`:

```ts
const adapter = createFakeHarnessAdapter({
  script: ({ attempt }) =>
    attempt === 1 ? retryableFailure("sandbox denied") : writesFiles({ "hello.txt": "hi\n" }),
});
```

A script can also stream, which is how a scenario waits for a control action:

```ts
{
  async *stream(ctx) {
    yield { type: "permission_request", requestId: "p1", description: "…", risk: "high" };
    const approved = await ctx.awaitPermission("p1");   // resolves undefined on cancel
    if (approved) await ctx.writeFiles({ "hello.ts": "…" });
  },
}
```

### Using it in dev

`NEXESTRA_FAKE_HARNESS=1` is the agreed switch for running the server's
orchestrator on the fake harness instead of a real one:

```bash
NEXESTRA_FAKE_HARNESS=1 pnpm dev
```

> Not yet honoured by `apps/server` — see §2, "The specs". Until it is, the
> fake is reachable from library code and tests only.

---

## 4. Recording a new fixture

Contract tests are only worth their weight if the recordings are real. To add
one:

1. Run the harness by hand and capture its raw stream, exactly as the adapter
   would invoke it:

   ```bash
   codex exec --json -s workspace-write -C /tmp/scratch --skip-git-repo-check \
     "Add add(a,b) to src/math.ts and a test, then run node --test" \
     > fixtures/codex/exec-my-case.jsonl

   opencode serve --port 4096 &
   curl -N http://127.0.0.1:4096/event > fixtures/opencode/my-case.event-v1.sse
   ```

2. Write the sibling `*.meta.json`. It is not optional — it is what tells the
   next reader which harness version the recording proves anything about:

   ```json
   {
     "harness": "codex",
     "harnessVersion": "codex-cli 0.148.0",
     "platform": "darwin arm64 (Darwin 27.0.0)",
     "node": "v24.19.0",
     "recordedAt": "2026-09-02",
     "scenario": "successful edit+test task (workspace-write)",
     "argv": ["codex", "exec", "--json", "…"],
     "cwd": "/WORK/codex-a",
     "exitCode": 0,
     "notes": "anything surprising about this run"
   }
   ```

3. Scrub it. Recordings are committed: no absolute home directories, no tokens,
   no customer code. Replace paths with `/WORK/…`.

4. The parser tests replay **every** file in the fixture directory, so a new
   recording is picked up without registering it anywhere. Add a named
   assertion only for what is new about it.

5. When the recording came from a newer harness, bump `TESTED_CODEX_VERSION` /
   the OpenCode equivalent in the adapter's `options.ts` so `discover()` warns
   about the drift honestly.

---

## 5. Live tests

Every test that costs money or needs a logged-in CLI is skipped by default and
opts in through an environment variable. They are smoke tests of *shape* — that
the real endpoint accepts what the adapter sends — not of model judgement.

| Variable | Runs | Command |
|----------|------|---------|
| `NEXESTRA_LIVE_CODEX=1` | the Codex adapter and the orchestrator against the real `codex` CLI | `NEXESTRA_LIVE_CODEX=1 pnpm --filter @nexestra/adapter-codex test` |
| `NEXESTRA_LIVE_CODEX_MODEL` | overrides the model those use | — |
| `NEXESTRA_LIVE_OPENCODE=1` | the OpenCode adapter against a real `opencode serve` | `NEXESTRA_LIVE_OPENCODE=1 pnpm --filter @nexestra/adapter-opencode test` |
| `NEXESTRA_LIVE_OPENCODE_MODEL` | overrides that model (default `openai/gpt-5.4-mini`) | — |
| `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) | the Master's one live turn against `claude-opus-5` | `ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @nexestra/master test` |

The e2e suite deliberately strips `ANTHROPIC_API_KEY` from the server's
environment, so exporting one in your shell does not silently turn the
Playwright run into a paid, non-deterministic one.

---

## 6. The gates

```bash
pnpm typecheck   # tsc --noEmit in every package, including e2e
pnpm lint        # biome check .
pnpm test        # unit + contract + integration; excludes e2e
pnpm build       # apps/web/dist and apps/server/dist
pnpm e2e         # build, then Playwright
```

`pnpm test` is `pnpm -r --parallel test`, and the `@nexestra/e2e` package has no
`test` script — so the browser suite never runs as part of it. It is a separate
gate on purpose: it needs a build and a browser, and it is measured in seconds
rather than milliseconds.
