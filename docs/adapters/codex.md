# Codex adapter (`@nexestra/adapter-codex`)

Implements `HarnessAdapter` (PLAN.md §5) on top of `codex exec --json`.
The wire protocol it consumes was recorded from **Codex CLI 0.148.0** and is
documented in [`docs/harness-protocols.md`](../harness-protocols.md) §1; the
recordings themselves are in `fixtures/codex/`.

Milestone: **M4**. Status: implemented, contract-tested against every fixture,
smoke-tested against the real binary.

---

## 1. Public API

```ts
import { createCodexAdapter } from "@nexestra/adapter-codex";

const adapter = createCodexAdapter({ ephemeral: true, defaultModel: "gpt-5.1-codex" });

const info      = await adapter.discover();              // HarnessInfo
const prepared  = await adapter.prepare(spec);           // PreparedRun
for await (const event of adapter.run(prepared, signal)) { … }   // HarnessEvent
await adapter.control(prepared.runId, { action: "cancel" });
```

`createCodexAdapter()` returns a `CodexAdapter`, which is a `HarnessAdapter`
plus two extras:

| Member | Purpose |
|---|---|
| `controlDetailed(runId, action)` | Same as `control()` but returns a typed `CodexControlResult` instead of throwing for unsupported actions. |
| `runs: ReadonlyMap<string, CodexRunHandle>` | Runs this instance has prepared, with their manifest and live `AbortController`. |

### Options (`CodexAdapterOptions`)

| Option | Default | Effect |
|---|---|---|
| `binaryPath` | — | Skip discovery and use this `codex` binary. |
| `extraSearchPaths` | `~/.local/bin`, `~/.codex/bin`, `~/bin` | Searched after `PATH`. |
| `env` | `{}` | Overlaid on `process.env` for every spawned process, and stored verbatim in `PreparedRun.env`. |
| `defaultModel` | — | Used when `RunSpec.model` is absent. |
| `models` | `KNOWN_CODEX_MODELS` | Reported by `discover()` — Codex has no `models list` command. |
| `ephemeral` | `false` | Adds `--ephemeral` (no rollout files under `~/.codex/sessions`). |
| `ignoreUserConfig` | `false` | Adds `--ignore-user-config`; MCP servers must then be re-supplied per run. |
| `configOverrides` | `{}` | Extra `-c key=value` pairs on every run. |
| `extraArgs` | `[]` | Appended verbatim, just before the prompt. |
| `relativisePaths` | `true` | `file_changed.path` is emitted relative to the run cwd. |
| `computeDiff` | `true` | Compute a real `git diff` after the run and attach it to `final.structured.diff`. |
| `diffBase` | `HEAD` (or the empty tree) | Ref the post-run diff is taken against. |
| `maxDiffBytes` | 1 MiB | Cap on the captured patch. |
| `killGraceMs` | 5000 | `SIGTERM` → `SIGKILL` grace period for the process group. |
| `stderrTailBytes` | 8192 | Stderr retained for error messages. |
| `runIdFactory` | `run_<base36>` | Run id generation. |
| `priceUsage(model, usage)` | — | Fills `usage.costUSD`. Codex reports **token counts only**; no price table ships with the adapter, so cost stays absent unless you supply one. |
| `logger` | no-op | `{debug, warn}` for skipped lines and process events. |

The worktree helper is also exported (and available as
`@nexestra/adapter-codex/worktree`): `ensureWorktree`, `removeWorktree`,
`diff`, `changedFiles`, `isGitRepo`, `repoRoot`, `hasCommits`. Creating the
worktree is the orchestrator's job — the adapter only receives `RunSpec.cwd` —
but both sides need the same primitives, so they live here until an
`@nexestra/git` package earns its keep.

---

## 2. `discover()`

1. Locate the binary: `options.binaryPath` → every `PATH` entry → the extra
   search paths (the installer puts `codex` in `~/.local/bin`, which a
   non-login shell often does not have).
2. `codex --version` → `codex-cli 0.148.0` → `0.148.0`.
3. `codex login status` → `authOk` when it exits 0 and says *logged in*.

Version handling is deliberately loud, because **`codex exec --json` has no
published schema**: it is absent from `codex app-server generate-json-schema`
output and only typed inside `@openai/codex-sdk`.

| Constant | Value |
|---|---|
| `TESTED_CODEX_VERSION` | `0.148.0` — what the fixtures were recorded from |
| `SUPPORTED_CODEX_RANGE` | `>=0.140.0 <0.150.0` |

- Version ≠ tested → warning ("the event stream may have changed").
- Version outside the range → stronger warning ("the JSONL parser may drop or
  mis-map events").

`HarnessInfo.sandboxModes` reports `read-only | workspace-write |
danger-full-access`, taken from `codex exec --help`.

---

## 3. `prepare()` — flag mapping

`prepare()` creates `<cwd>/.nexestra/runs/<runId>/` containing
`instructions.md` (a record of the prompt), `run.json` (the manifest `run()`
reads back, so a restarted process can still stream a prepared run),
`output-schema.json` (when a schema is used) and the `-o` target
`last-message.md`. That directory is excluded from the computed diff via the
`:(exclude).nexestra` pathspec.

```
codex exec --json -C <cwd> -s <sandbox> --skip-git-repo-check
  [-m <model>] [--ephemeral] [--ignore-user-config]
  -o <run-dir>/last-message.md [--output-schema <run-dir>/output-schema.json]
  [-c model_reasoning_effort=<level>] [-c mcp_servers.…] [extraArgs…] "<prompt>"
```

| `RunSpec` | Codex |
|---|---|
| `cwd` | `-C <cwd>`, and the child process cwd |
| `instructions` | positional `PROMPT` in argv, with **stdin closed** |
| `model` | `-m` |
| `reasoning` (`low\|medium\|high\|xhigh`) | `-c model_reasoning_effort=<same>` |
| `sandbox` | `-s` |
| `outputSchema` | `--output-schema <file>` |
| `mcpServers` | `-c mcp_servers.<name>.command="…"` / `.args=[…]` / `.url="…"` |
| `timeoutMs` | adapter-side timer, then a process-group kill |
| `tools` | **ignored** — `codex exec` cannot select tools per run (warning) |
| `skills` | **ignored** — use `AGENTS.md` in the worktree (warning) |
| `budgetUSD` | not enforced here; the orchestrator owns budgets |

Two details are load bearing:

- **The prompt goes in argv and stdin is `"ignore"`.** With a readable non-TTY
  stdin, Codex prints `Reading additional input from stdin...` and appends
  whatever it reads as a `<stdin>` block to the prompt.
- **`-c model_reasoning_effort` is validated client-side.** Codex accepts an
  invalid value silently — exit 0, nothing on stderr, nothing in the JSONL.

`PreparedRun.env` holds only `options.env`, never a copy of `process.env`: the
prepared run is persisted into the event store, and a copy of the environment
would take every secret in it along.

### Review runs (`kind: "review"`)

`codex exec review` is a different command with a different flag set — checked
against `codex exec review --help` on 0.148.0, it has **no `-C` and no `-s`**.
The adapter therefore sets the child cwd instead of `-C`, and warns that the
requested sandbox is ignored.

```
codex exec review --json --skip-git-repo-check -o <file>
  [--output-schema <file>] [-m <model>]
  (--uncommitted | --base <ref> [PROMPT] | --commit <sha> [PROMPT])
```

The target comes from the additive optional `RunSpec.reviewTarget`
(`{mode:"uncommitted"} | {mode:"base", ref} | {mode:"commit", sha}`), and
defaults to `uncommitted`. `--uncommitted` **cannot be combined with a
prompt** — the CLI exits 2 — so `prepare()` throws a `CodexPrepareError`
rather than silently dropping the instructions.

The recorded review answered in prose and reported all-zero usage, so pass
`RunSpec.outputSchema = CODEX_REVIEW_FINDINGS_SCHEMA` (exported) to get
machine-readable findings; anything else you supply wins.

---

## 4. `run()` — event mapping

Spawned with `execa`, `stdin: "ignore"`, `detached: true` (its own process
group) and `buffer: false`; stdout is consumed as a stream and fed to
`CodexStreamParser` chunk by chunk.

| Codex JSONL | `HarnessEvent` |
|---|---|
| `thread.started` | `{type:"started", sessionRef: thread_id}` |
| `turn.started` | dropped (state only) |
| `item.completed` + `agent_message` | `{type:"assistant_text", text}` |
| `item.completed` + `reasoning` | `{type:"reasoning", text}` (never observed; may be absent entirely) |
| `item.started` + `command_execution` | `{type:"command", cmd}` — announced once per item id |
| `item.completed` + `command_execution` | `{type:"command", cmd, exitCode, stdout: aggregated_output}` |
| `item.completed` + `file_change` | one `{type:"file_changed", path, kind}` per `changes[]`; `update → modify` |
| `item.started` + `mcp_tool_call` | `{type:"tool_call", name:"<server>/<tool>", input: arguments, callId: item.id}` |
| `item.completed` + `mcp_tool_call` | `{type:"tool_result", callId, output: result ?? error, ok: status === "completed"}` |
| `item.started` + `web_search` | `{type:"tool_call", name:"web_search", input:{query}, callId}` |
| `item.started` + `todo_list` | `{type:"tool_call", name:"todo_list", input:{items}, callId}` |
| `item.updated` / `item.completed` + `todo_list` | `{type:"tool_result", callId, output:{items, done}, ok:true}` — plan progress |
| `item.completed` + `error` | `{type:"error", message, retryable}` |
| `turn.completed` | `{type:"usage", inputTokens, outputTokens}` (+ `costUSD` when a pricer is set) |
| `turn.failed` / top-level `error` | `{type:"error", message, retryable}` |
| process exit | `{type:"final", …}` then `{type:"ended", exitCode}` |
| — | `permission_request` is **never emitted**; `exec` has no approval channel |

Decisions worth knowing:

- **`stderr` is always undefined on `command` events.** Codex merges stdout and
  stderr into `aggregated_output` with no separation; duplicating the same
  bytes into both fields would be a lie.
- **`command` is emitted twice per command** — once on `item.started` (no exit
  code, so a UI can show it running) and once on `item.completed`.
- **`file_changed` is emitted only on `item.completed`**, so a patch that fails
  to apply is not reported as a change.
- **Paths are relativised** against the run cwd (`relativisePaths: false` to
  opt out). Paths outside the cwd stay absolute. Both harnesses emit absolute
  paths, and storing them leaks machine paths into fixtures and the UI.
- **`usage` carries token counts only.** The full Codex breakdown
  (`cached_input_tokens`, `cache_write_input_tokens`,
  `reasoning_output_tokens`) is preserved in `final.structured.usage`.
  Review runs report **all-zero usage** — do not budget on it.
- **Unknown `type` and unknown `item.type` are logged and skipped**, never
  fatal. So are malformed lines and a truncated trailing line.

### Terminal events

| Situation | Emitted |
|---|---|
| `turn.completed` and exit 0 | `usage`, `final`, `ended` |
| Aborted (`AbortSignal` or `control(cancel)`) | `error{message:"cancelled"\|reason, retryable:false}`, `ended`. **`final` is deliberately absent.** |
| Timeout (`RunSpec.timeoutMs`) | `error{message:"timeout after Nms", retryable:true}`, `ended` |
| Stream ended without `turn.completed`, or non-zero exit | `error{message, retryable}`, `ended`; no `final` |

Cancellation is silent in Codex: `SIGINT` gives exit 1 with **no terminal event
at all** and the `-o` file is never written, so the adapter synthesises both
events from the signal.

### `final.message` and `final.structured`

`final.message` is the `-o` file when it exists, otherwise the last
`agent_message`. `final.structured` is a `CodexFinalStructured`:

```ts
{
  threadId?: string;
  output?: unknown;                  // JSON.parse of the final message, when --output-schema was used
  findings?: CodexReviewFinding[];   // review runs; [] when the review answered in prose
  reviewSummary?: string;
  diff?: WorktreeDiff;               // the real git diff — see below
  fileChanges?: { path, kind }[];    // as Codex reported them
  todos?: { text, completed }[];
  usage?: CodexUsage;                // full token breakdown
  warnings?: string[];               // e.g. "RunSpec.tools is ignored"
}
```

With `--output-schema`, Codex returns the JSON as a **string** in the final
`agent_message` — there is no separate structured field — so the adapter
parses it into `structured.output`.

### The diff

Codex' `file_change` item carries `{path, kind}` and **no patch content at
all**. After the process exits (and before `final` is emitted, so the diff
travels with it) the adapter computes the real diff with the git helper:

- `git status --porcelain -z --untracked-files=all` for the file list;
- `git diff <base>` for tracked changes, plus `git diff --no-index /dev/null
  <file>` for each untracked file — a plain `git diff` would miss every file
  the harness created;
- nothing is ever staged, and `.nexestra` is excluded;
- the patch is truncated at `maxDiffBytes` with a marker.

`git diff` is also the only trustworthy view after a cancel: a recorded run
whose parent shell was torn down left the JSONL truncated **while the codex
child kept editing files**. Verify the worktree, do not trust the last event.

### Process groups

`detached: true` puts Codex in its own process group, so cancel does
`process.kill(-pid, "SIGTERM")` and, after `killGraceMs`, `SIGKILL`. This
matters because Codex runs the model's shell commands through `/bin/zsh -lc
…`: killing only the leader leaves the tree running. Abandoning the async
iterator (a `break` in the `for await`) kills the group too.

---

## 5. `control()`

| Action | Behaviour |
|---|---|
| `cancel` | Supported. Aborts the run, killing the process group. `reason` becomes the `error` message. |
| `pause` / `resume` | **Unsupported.** `codex exec` runs one turn to completion; pausing would mean killing the process and later `codex exec resume <thread_id>`. |
| `steer` | **Unsupported.** The prompt is a single argv entry and stdin is closed — there is no channel for a mid-run message. |
| `answer_permission` | **Unsupported.** `exec` never asks; it runs whatever the sandbox allows. |

`control()` returns `Promise<void>` (the `HarnessAdapter` signature) and throws
`CodexUnsupportedControlError` — carrying `action`, `reason` and
`requires: "app-server"` — for the unsupported ones.
`controlDetailed()` returns the same information as a value:

```ts
{ action: "steer", supported: false, reason: "…", requires: "app-server" }
```

Cancelling an unknown or idle run is not an error: it returns
`{supported: true, applied: false, note}`.

---

## 6. Limitations

1. **No permissions.** `exec` has no approval channel at all, so
   `HarnessEvent.permission_request` is never emitted. Escalation is a
   pre-flight decision: the Master asks for an Approval, then the run is
   spawned with the higher `-s` level.
2. **No steering and no pause.** One prompt, one turn.
3. **No per-run tool selection** and no skills flag.
4. **No cost.** Token counts only; Nexestra must price them from the model id.
5. **Review usage is all zeros** and review ignores `-s`.
6. **No published schema for the event stream.** Pin the version, watch the
   `discover()` warnings, and keep the parser tolerant.
7. **`reasoning` items were never observed** even though usage reported
   `reasoning_output_tokens`; they may need
   `-c show_raw_agent_reasoning=true`. Assume they can be absent.
8. **MCP servers are injected as `-c` overrides** rather than a dedicated flag,
   which `codex exec` does not have.

---

## 7. Tests

```
pnpm --filter @nexestra/adapter-codex test
```

- `parser.test.ts` — replays **every** `fixtures/codex/*.jsonl` recording,
  asserts each emitted event validates against `HarnessEventSchema`, checks the
  event sequences, usage totals, final-message extraction, structured-output
  parsing, chunk-size independence (1 / 7 / 64 / 997 byte chunks produce
  identical events), truncated tails, CRLF, garbage lines and unknown
  `type` / `item.type`.
- `command.test.ts` — argv construction, including a comparison against the
  recorded `argv` in the fixtures' `*.meta.json`.
- `discover.test.ts` — version parsing, range checks, PATH search, the warning
  matrix.
- `adapter.test.ts` — end-to-end runs against a **real shell script standing in
  for `codex`** (`FAKE_CODEX_SCRIPT`), which is the only way to exercise
  `detached`, the process-group kill and an orphaned grandchild. Covers the
  happy path, `-o` fallback, diff attachment, review findings, CLI argument
  errors, streams that stop without `turn.completed`, cancel via signal and via
  `control()`, timeouts, abandoning the iterator, and manifest recovery from
  disk.
- `worktree.test.ts` — `ensureWorktree` / `removeWorktree` / `diff` against a
  temporary git repository.
- `live.test.ts` — opt-in smoke test against the real binary:

  ```
  NEXESTRA_LIVE_CODEX=1 pnpm --filter @nexestra/adapter-codex test
  ```

  It builds a throwaway git repo, asks Codex to create `hello.txt`, and asserts
  `file_changed` + `final` + `ended` plus the file on disk. Last run:
  **passed in 13.1 s against codex-cli 0.148.0** (macOS, ChatGPT login).

---

## 8. Adding `codex app-server` later

`app-server` is the v2 path and the only way to get approvals and steering
(PLAN.md §1.8). The shape of that work:

1. **Transport.** `codex app-server` speaks JSON-RPC over stdio by default
   (`--listen stdio://`); `unix://` and `ws://` also exist, and
   `codex app-server daemon` / `proxy` manage a shared background instance.
2. **Schemas.** `codex app-server generate-json-schema --out <dir>` (the
   `--out` is mandatory) — already generated into
   `fixtures/codex/app-server/`. `generate-ts --out <dir>` emits ~250 `.ts`
   files under `v1/` and `v2/`.
3. **The approval requests to wire to Nexestra's Approval queue:**
   `ExecCommandApprovalParams`, `ApplyPatchApprovalParams`,
   `CommandExecutionRequestApprovalParams`, `FileChangeRequestApprovalParams`,
   `PermissionsRequestApprovalParams`, `McpServerElicitationRequestParams`,
   `ToolRequestUserInputParams`.
4. **What can be reused as-is:** `discover.ts`, `command.ts`'s flag mapping,
   `worktree.ts`, `review.ts` and the whole `CodexFinalStructured` shape. What
   changes is transport and the event source.
5. **What cannot:** `parser.ts`. The app-server schema does **not** describe
   `codex exec --json` — grepping the generated output for
   `command_execution`, `file_change` or `todo_list` returns nothing. Expect a
   second mapping table alongside the existing one, selected by the transport,
   rather than an edit to `CodexStreamParser`.
6. `@openai/codex-sdk` (0.152.x) is a typed wrapper that spawns the same CLI
   and parses the same JSONL — it is not a separate API, and taking the
   dependency would not have bought the `AbortSignal`, process-group and stderr
   handling this adapter needs.
