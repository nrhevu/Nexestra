# OpenCode adapter (`@nexestra/adapter-opencode`)

Implements `HarnessAdapter` (PLAN.md §5) on top of `opencode serve` — the HTTP
API plus the `GET /event` SSE stream. The wire protocol it consumes was recorded
from **OpenCode 1.18.25** and is documented in
[`docs/harness-protocols.md`](../harness-protocols.md) §2; the recordings
themselves are in `fixtures/opencode/`.

Milestone: **M5**. Status: implemented, contract-tested against every fixture,
smoke-tested against the real binary (`openai/gpt-5.4-mini`, 2026-09-02).

---

## 1. Public API

```ts
import { createOpenCodeAdapter } from "@nexestra/adapter-opencode";

const adapter = createOpenCodeAdapter({ defaultModel: "openai/gpt-5.4-mini" });

const info     = await adapter.discover();                     // HarnessInfo
const prepared = await adapter.prepare(spec);                  // PreparedRun
for await (const event of adapter.run(prepared, signal)) { … } // HarnessEvent
await adapter.control(prepared.runId, { action: "cancel" });
await adapter.dispose();                                       // stop the servers
```

`createOpenCodeAdapter()` returns an `OpenCodeAdapter`: a `HarnessAdapter` plus

| Member | Purpose |
|---|---|
| `controlDetailed(runId, action)` | Same as `control()` but returns a typed `OpenCodeControlResult` instead of throwing for unsupported actions. |
| `runs: ReadonlyMap<string, OpenCodeRunHandle>` | Runs this instance has prepared, with their manifest, mapper and live `AbortController`. |
| `servers: OpenCodeServerManager` | The `opencode serve` processes this adapter owns, keyed by workspace directory. |
| `dispose()` | Disposes every server this adapter started. **Call it**: servers are long lived by design. |

### Why plain `fetch`, not `@opencode-ai/sdk`

`npm view @opencode-ai/sdk version` → `1.18.26` while the binary here is
`1.18.25`: the package and the server version independently, the package
publishes no README, and the API surface this adapter needs is ten endpoints.
The event stream has to be hand-rolled anyway — it is long lived, must survive
reconnects, and unknown-event tolerance has to stay under Nexestra's control
(`harness-protocols.md` §2.10). So the request surface is hand-written from the
recorded OpenAPI document (`fixtures/opencode/openapi.json`) in `client.ts`,
with Node 24's global `fetch`, and the SSE framing lives in `sse.ts`.
Revisit when the SDK stabilises around a v2 event stream.

### Options (`OpenCodeAdapterOptions`)

| Option | Default | Effect |
|---|---|---|
| `binaryPath` | — | Skip discovery and use this `opencode` binary. |
| `extraSearchPaths` | `~/.opencode/bin`, `~/.local/bin`, `~/bin` | Searched after `PATH`. |
| `env` | `{}` | Overlaid on `process.env` for every spawned server, and stored verbatim in `PreparedRun.env`. |
| `attachUrl` | — | Attach to an already-running server instead of spawning one. Nothing is started or disposed. |
| `pure` | `true` | Passes `--pure`. Without it ~45 external plugins register themselves and 13 % of the stream is `plugin.added`. |
| `logLevel` | `INFO` | `--log-level`. `--print-logs` is always passed: the bound port is printed nowhere else. |
| `extraServeArgs` | `[]` | Appended to `opencode serve`. |
| `startTimeoutMs` | `30000` | Budget for "print a port" **and** "answer `/global/health`". |
| `requestTimeoutMs` | `30000` | Per-request timeout for ordinary HTTP calls. |
| `killGraceMs` | `5000` | SIGTERM → SIGKILL grace for the server's process group. |
| `idleSettleMs` | `250` | How long the run keeps draining after `session.idle`; the final `message.updated` trails it. |
| `abortTimeoutMs` | `10000` | How long an abort waits for the session to report idle. |
| `reconnectDelayMs` / `reconnectMaxDelayMs` | `250` / `8000` | SSE reconnect backoff (doubling, full jitter). |
| `defaultModel` | — | `provider/model` used when `RunSpec.model` is absent. |
| `defaultProviderId` | — | Provider assumed when `RunSpec.model` has no `provider/` prefix. |
| `models` | from `GET /provider` | Overrides the model list reported by `discover()`. |
| `agent` / `reviewAgent` | `build` / `plan` | Agents for execute/verify and review runs. |
| `variantFor(reasoning, model)` | table below | Overrides the `reasoning` → `variant` mapping. |
| `permissionRuleset(sandbox)` | table below | Replaces the whole sandbox → permission mapping. |
| `readOnlyBashAction` | `deny` | What `read-only` does with `bash`. `ask` routes it to the Approval queue instead. |
| `streamDeltas` | `false` | Emit one `assistant_text` / `reasoning` per SSE delta instead of one per completed part. |
| `relativisePaths` | `true` | Emit `file_changed.path` relative to the run cwd. |
| `computeDiff` / `diffBase` / `maxDiffBytes` | `true` / `HEAD` / 1 MiB | Post-run `git diff` attached to `final.structured.diff`. |
| `runIdFactory` | `run_<base36>` | Run id generator. |
| `priceUsage(model, usage)` | — | Fallback pricer used when OpenCode reports `cost: 0`. |
| `fetch` | global | Injected `fetch`, for tests. |
| `logger` | no-op | `debug` / `warn`. |

---

## 2. Launch and lifecycle

### One server per workspace

The server is rooted at its CWD for project detection, so Nexestra runs one per
worktree rather than one global server plus `?directory=`:

```
opencode serve --port 0 --hostname 127.0.0.1 --print-logs --log-level INFO --pure
```

`OpenCodeServerManager.ensure(directory)`:

1. returns the cached server if it is alive **and** still answers
   `GET /global/health` (a 5 s check);
2. otherwise disposes it and starts a new one — concurrent `ensure()` calls for
   the same directory share one start;
3. parses `opencode server listening on http://127.0.0.1:<port>` out of the
   merged stdout/stderr (`--port 0` prints the chosen port nowhere else), then
   polls `/global/health` until it answers;
4. records `health.version` so `discover()` and the mismatch warning have it.

The process is spawned `detached` (its own process group) because the server
spawns the model's shell commands; disposal is `POST /instance/dispose`, then
`SIGTERM` to the **group**, then `SIGKILL` after `killGraceMs`. A server that
exits on its own is marked dead, its listeners fire, and the next `ensure()`
starts a replacement. `dispose()` on the adapter tears every server down.

### One SSE connection per server

`GET /event` is global: every session on the server plus session-less noise
arrives on one stream. `OpenCodeEventStream` therefore keeps **one** connection
per server and demultiplexes by `properties.sessionID` (which lives directly on
`properties`, on `properties.info` or on `properties.part`, depending on the
variant). It reconnects with doubling backoff and full jitter, and `run()`
awaits `ready()` **before** prompting — `prompt_async` returns 204 immediately
and the whole transcript is on the stream, so a late subscription loses the
first parts.

Events that carry **no** session id (`file.edited` above all) are routed to the
run only when exactly one run is streaming on that server; otherwise they are
dropped. They are redundant: the tool part that caused the write carries the
same paths and the actual diff.

After a reconnect the adapter warns, counts it into
`final.structured.reconnects`, and re-checks `GET /session/status` — a session
that finished while the stream was down must not hang the run.

---

## 3. `discover()`

1. Locate the binary (`binaryPath` → `PATH` → `~/.opencode/bin`, …).
2. `opencode --version` → the version string.
3. Start a **short-lived** server in the probe directory (`process.cwd()` by
   default) unless one is already running there, then read `GET /global/health`,
   `GET /provider` and `GET /agent`. A server the probe started is disposed
   again.
4. Fall back to `opencode models` (which prints `provider/model` lines) when the
   server cannot be interrogated.

| `HarnessInfo` field | Source |
|---|---|
| `available` | the server came up, or the binary reported a version |
| `version` | `GET /global/health` → `version`, else `opencode --version` |
| `supportedVersionRange` | `>=1.18.0 <2.0.0`; tested version is `1.18.25` |
| `models` | `GET /provider`, **connected providers first** |
| `defaultModel` | `provider.default[p]` for the first *connected* `p` |
| `sandboxModes` | always all three — they are emulated, see §5 |
| `authOk` | `GET /provider` → `connected.length > 0` |

Warnings are raised for: a missing binary, a version that differs from the
tested one, a version outside the range, no connected provider, a configured
default model that is not in the catalogue, and an agent that is not configured.

The connected-provider check is not ceremony: the recording machine's default
model was `9router/…` pointing at a local proxy that was not running, and a
prompt against it returned HTTP 200 and *then* failed after five retries and
64 s (`harness-protocols.md` §4.5). The adapter therefore always sends an
explicit `{providerID, modelID}` and refuses to guess.

---

## 4. `prepare()` — session creation

| `RunSpec` | OpenCode |
|---|---|
| `cwd` | the workspace the server is rooted at; also `?directory=` on every call |
| `taskId` | `POST /session` → `title` |
| `instructions` | the prompt's `parts:[{type:"text",text}]` (wrapped for review runs, §7) |
| `model` | `provider/model` split on the **first** slash — model ids contain slashes (`9router/dsv4/deepseek-v4-flash-0731`) |
| `reasoning` | `model.variant`: `low→low`, `medium→medium`, `high→high`, `xhigh→max` |
| `sandbox` | a per-session `permission` ruleset **plus** a `tools` map (§5) |
| `tools` | `tools:{[id]: boolean}` on the prompt, as an allow-list |
| `outputSchema` | `format:{type:"json_schema",schema}` → `AssistantMessage.structured` |
| `kind` | picks the agent: `build` for execute/verify, `plan` for review |
| `timeoutMs` | adapter-side timer → `POST /session/{id}/abort` |
| `mcpServers` | **not wired**; warns. Register with `POST /mcp` + `/mcp/{name}/connect` first |
| `skills` | ignored; OpenCode resolves skills from its own config |

`prepare()` writes `<cwd>/.nexestra/runs/<runId>/`:

| File | Contents |
|---|---|
| `instructions.md` | `RunSpec.instructions`, verbatim |
| `prompt.md` | the wrapped reviewer prompt (review runs only) |
| `run.json` | the manifest: session id, server URL, model, agent, permission ruleset, tools, timeout, warnings |

The manifest is what lets `run()` and `control()` work in a fresh process:
sessions live on disk inside OpenCode, so a restarted Nexestra can re-attach to
one it created earlier.

`PreparedRun.command` / `.args` describe the **server** command line, since that
is the only process the adapter spawns. `PreparedRun.env` holds the `options.env`
overlay only — never a copy of `process.env`, which would land in the event
store with every secret in it.

---

## 5. Permission mapping

OpenCode has **no sandbox concept**. The only per-run lever that does not mutate
global config is the `permission` field of `POST /session`
(`harness-protocols.md` §2.6). Rule resolution is by *specificity*, not by
order — the built-in `plan` agent relies on `{edit,*,deny}` losing to
`{edit,.opencode/plans/*.md,allow}` — so every ruleset below names concrete
permission keys rather than leaning on a `*` catch-all.

| `RunSpec.sandbox` | Ruleset |
|---|---|
| `read-only` | `read`/`grep`/`glob`/`list`/`todowrite` → allow; `edit`/`write`/`patch`/`apply_patch` → deny; `webfetch`/`websearch` → deny; `external_directory` → deny; `bash` → **deny** (`readOnlyBashAction: "ask"` to route it to the Approval queue instead); `doom_loop` → ask |
| `workspace-write` | reads + `edit`/`write`/`patch`/`apply_patch`/`bash`/`task`/`skill` → allow; `external_directory` → **ask** (anything outside the worktree); `webfetch`/`websearch` → **ask** (network); `doom_loop` → ask |
| `danger-full-access` | `{permission:"*", pattern:"*", action:"allow"}` |

Belt and braces: below `workspace-write` the write and network tools are also
switched **off** in the prompt's `tools` map, so a future OpenCode that resolves
a rule differently still cannot produce a write in a read-only run.
`RunSpec.tools`, when given, is an allow-list applied on top.

`bash` is denied rather than filtered in `read-only` because there is no way to
tell a reading command from a writing one before it runs.

### The ask cycle

```
permission.asked  → HarnessEvent { type:"permission_request", requestId:"per_…", description, risk }
control(runId, { action:"answer_permission", requestId, approved })
                  → POST /session/{id}/permissions/{permissionID} {response:"once"|"reject"}
permission.replied → dropped (the orchestrator already knows)
```

`always` is opt-in: pass `note: "always"` with `approved: true`. It is never the
default, because "allow this pattern forever" must be a deliberate act. If the
session-scoped route fails the adapter retries the flat
`POST /permission/{requestID}/reply`.

`risk` is `low` for `read`/`grep`/`glob`/`list`/`question` and `high` for
everything else (writes, shells, the network, anything outside the worktree).

The separate **question** channel (`question.asked`) is surfaced as a
`permission_request` too, and answered on `/question/{id}/reply` (approve, with
`note` as the answer) or `/question/{id}/reject` (deny).

---

## 6. `run()` — event mapping

| OpenCode | `HarnessEvent` |
|---|---|
| `POST /session` (in `prepare()`) | `{type:"started", sessionRef: session.id}` — emitted first by `run()` |
| `message.part.updated`, `part.type:"text"`, `time.end` set | `{type:"assistant_text", text}` |
| `message.part.updated`, `part.type:"reasoning"`, `time.end` set | `{type:"reasoning", text}` |
| `message.part.delta`, `field:"text"` | accumulated into the part; emitted per delta only with `streamDeltas: true` |
| `message.part.updated`, `part.type:"tool"`, state `running` | `{type:"tool_call", name: part.tool, input: state.input, callId: part.callID}` |
| … state `completed` | `{type:"tool_result", callId, output: state.output, ok:true}` |
| … state `error` | `{type:"tool_result", callId, output: state.error, ok:false}` |
| … tool `bash`, completed | additionally `{type:"command", cmd, exitCode: metadata.exit, stdout}` |
| … tool metadata `files[]` / `filePath` (write tools only) | `{type:"file_changed", path, kind}` |
| `message.part.updated`, `part.type:"patch"` | `file_changed` per `files[]` |
| `file.edited` | `file_changed` (kind `modify`), when attributable |
| `message.part.updated`, `part.type:"step-finish"` | `{type:"usage", inputTokens, outputTokens, costUSD: cost}` |
| `session.status {type:"retry"}` | **nothing** — progress, counted in `structured.retries` |
| `session.error` / `info.error`, `MessageAbortedError` | `{type:"error", message:"cancelled", retryable:false}` |
| `session.error` / `info.error`, anything else | `{type:"error", message:"<Name>: <message>", retryable: data.isRetryable}` |
| `permission.asked` / `question.asked` | `{type:"permission_request", …}` |
| `session.idle` / `session.status {type:"idle"}` after a `busy` | terminal → `final` + `ended` |
| the other ~76 known event types | dropped, counted in `state.ignoredEvents` |
| a type outside the 1.18.25 union | dropped, counted in `structured.unknownEvents` |

Details worth knowing:

- **Text is emitted per completed part, not per delta.** A part is finished when
  its `time.end` is set. `message.part.delta` carries `field:"text"` for *both*
  text and reasoning parts, so the part's own type decides which event it
  becomes. `streamDeltas: true` flips to one event per delta, and then the
  completing update does not repeat the text.
- **The user's own prompt arrives as a text part.** Roles are learned from
  `message.updated` and user parts are never emitted as `assistant_text`.
- **One prompt yields many assistant messages** — five in the recording, one per
  model step (§2.4). All of them stream through; the final answer is the last
  one that produced text.
- **Errors are reported once.** `session.error` and the assistant message's
  `info.error` carry the same payload; they are de-duplicated by name+message.
- **An `idle` before the first `busy` is ignored** — that is the resting state of
  a freshly created session, not the end of the prompt.
- **`reasoningEncryptedContent` never leaves the mapper.** Only `part.text` is
  read; the provider blob in `part.metadata` is dropped.

### Terminal events

| Outcome | Events |
|---|---|
| success | … `{type:"final", message, structured}`, `{type:"ended", exitCode:0}` |
| provider failure | `{type:"error", …, retryable}`, `{type:"ended", exitCode:1}` — **no `final`** |
| cancelled / timed out | `{type:"error", message:"cancelled"\|"timeout after Nms"}`, `{type:"ended", exitCode:1}` — **no `final`** |
| server died mid-run | `{type:"error", message:"opencode server exited…", retryable:true}`, `{type:"ended", exitCode:1}` |

### `final.message` and `final.structured`

`final.message` is fetched with `GET /session/{id}/message` and taken from the
last assistant message that produced text; the synchronous
`POST /session/{id}/message` response is *not* used, because it returns only the
last step and none of the tool calls (§2.4). The in-memory accumulation is the
fallback when the fetch fails.

`structured` is an `OpenCodeFinalStructured`:

| Field | Meaning |
|---|---|
| `sessionRef`, `agent`, `model`, `variant` | what actually ran |
| `output` | `AssistantMessage.structured` (from `format:{json_schema}`) |
| `findings`, `reviewSummary` | review runs only (§7) |
| `diff` | the real `git diff` of the worktree, excluding `.nexestra` |
| `fileChanges` | the `file_changed` events as emitted |
| `patches` | the unified diffs carried by `apply_patch`/`edit`/`write` metadata |
| `usage` | full breakdown: input, output, reasoning, cache read/write, `costUSD`, `steps` |
| `retries`, `reconnects`, `unknownEvents`, `finish`, `warnings` | run diagnostics |

Three sources describe the file changes and only one of them is authoritative:
`file.edited` and `patch` parts carry **no content**, the tool's
`state.metadata.diff` carries a unified diff *for that call*, and `git diff` in
the worktree carries the truth. `structured.diff` is the truth; the other two
are kept for provenance. `file_changed.kind` is a best guess (`modify` unless
the tool said otherwise) — use `structured.diff.files` when the kind matters.

---

## 7. Review runs (`kind: "review"`)

- The agent is `reviewAgent` (default `plan`, which denies every edit tool) and
  the sandbox is **forced to `read-only`** whatever the caller asked for; a
  warning records the override.
- The prompt is wrapped: scope from `RunSpec.reviewTarget`
  (`uncommitted` | `base <ref>` | `commit <sha>`), the caller's instructions,
  and a request to end with a single fenced ```json block of
  `{summary, findings:[{title, severity, file, line, body}]}`.
- The answer is parsed by `parseReviewFindings()` and validated with zod, in this
  order: `AssistantMessage.structured` → the **last** fenced block (models often
  show an example first) → the whole message as JSON. Severity synonyms are
  normalised (`blocker`→`critical`, `warning`→`medium`, `nit`→`low`).
- Prose answers are not an error: `findings` is `[]`, `final.message` keeps the
  prose, and a warning is added. Codex behaved the same way when it was not
  asked for structure (§1.7).
- `OPENCODE_REVIEW_FINDINGS_SCHEMA` is exported for callers who prefer
  `RunSpec.outputSchema` / `format:{json_schema}` over the fenced block.

---

## 8. `control()`

| Action | Implementation |
|---|---|
| `cancel` | `POST /session/{id}/abort`, then poll `GET /session/status` until the session is not `busy` (up to `abortTimeoutMs`). A streaming run is aborted through its `AbortController`, which does the same. |
| `answer_permission` | `POST /session/{id}/permissions/{permissionID} {response:"once"\|"always"\|"reject"}`, falling back to `POST /permission/{requestID}/reply`. Question-channel ids go to `/question/{id}/reply\|reject`. |
| `steer` | another `POST /session/{id}/prompt_async` on the same session — OpenCode queues it. |
| `pause` / `resume` | **unsupported.** `controlDetailed()` returns `{supported:false, reason}`; `control()` throws `OpenCodeUnsupportedControlError`. A session is either busy or idle; the closest equivalent is cancel + steer. |

`control()` works on a run that is not streaming (the manifest holds the session
id and the server URL), so an orchestrator restart can still cancel or answer.

---

## 9. Limitations

1. **No real sandbox.** Everything in §5 is an approximation built from
   permissions and tool gating. `read-only` cannot stop a `bash` command from
   writing — it can only refuse to run `bash` at all. There is no filesystem or
   network jail; use a container if you need one.
2. **`file.edited` has no session id.** It is attributed only when a single run
   is streaming on the server. With two concurrent runs in the same worktree
   those events are dropped — the tool parts still carry the same paths.
3. **A reconnect loses events.** The SSE stream has no resume cursor; events
   emitted while it was down are gone. The run still terminates correctly (the
   status is re-checked) and `final` is rebuilt from
   `GET /session/{id}/message`, but intermediate tool calls can be missing.
   `structured.reconnects` and a warning record it.
4. **`file_changed.kind` is a guess.** OpenCode reports `add`/`update`/`delete`
   only inside `apply_patch` metadata; elsewhere the adapter emits `modify`.
5. **Cost is often `0`.** `step-finish.cost` is a real USD number but reads `0`
   for subscription-billed providers. Supply `options.priceUsage` to fill it.
6. **MCP servers are not wired per run.** `RunSpec.mcpServers` warns; register
   them with `POST /mcp` + `POST /mcp/{name}/connect` before the run.
7. **`RunSpec.skills` is ignored.** OpenCode resolves skills from its own config
   and the `skill` tool.
8. **Variants are provider-specific.** `reasoning` → `variant` is a best-effort
   table; an unknown variant is silently ignored by the server. Override with
   `options.variantFor`.
9. **Two API surfaces and a third event family.** `/api/*` (v2) exists but its
   event stream was empty for the recorded run (§2.2), and the 24
   `session.next.*` events look like a replacement for `message.part.*` that had
   not been switched on. The mapper drops both and counts them; adding a second
   mapping table means one more `switch` in `mapper.ts`.
10. **`prepare()` needs a live server**, because it creates the session. It is
    therefore not a pure command-line builder the way the Codex one is.

---

## 10. Tests

```
pnpm --filter @nexestra/adapter-opencode test
```

| File | Covers |
|---|---|
| `sse.test.ts` | framing: comments, `\r\n`, split lines, multi-`data`, every fixture at three chunk sizes |
| `mapper.test.ts` | every `fixtures/opencode/*.sse` replayed through the mapper: event sequences, five assistant messages, usage/cost totals, bash → `command`, patches, permission cycle, abort, retries-are-not-errors, unknown types skipped |
| `permission.test.ts` | sandbox → ruleset, tool gating, risk and description |
| `review.test.ts` | prompt shape, fenced-block extraction, severity normalisation, prose fallback |
| `server.test.ts` | `ServerManager` lifecycle against a fake `opencode` binary: port parsing, reuse, concurrent starts, crash + restart, start failures, process-group kill, attach mode |
| `discover.test.ts` | version parsing and range, provider catalogue, every warning, the `opencode models` fallback, probe-server cleanup |
| `adapter.test.ts` | end to end over real HTTP + SSE against `FakeOpenCodeServer`: prepare/manifest/session body, the full recorded turn, subscribe-before-prompt, one stream per server, provider failure, abort, signal cancel, timeout, rejected prompt, permission answering, steer, review mode |
| `live.test.ts` | opt-in smoke test against the real binary |

The fake `opencode` binary (`FAKE_OPENCODE_SCRIPT`) is a real Node process that
prints the listening line and serves `/global/health`, so the port parsing,
`detached: true` and the process-group kill are exercised for real rather than
mocked.

### Live smoke test

```
NEXESTRA_LIVE_OPENCODE=1 pnpm --filter @nexestra/adapter-opencode test
NEXESTRA_LIVE_OPENCODE_MODEL=openai/gpt-5.4-mini   # default
```

It creates a throwaway git repo, asks for `hello.txt`, and asserts the file, the
diff, `usage` and `ended{exitCode:0}`. Last run on 2026-09-02 against OpenCode
1.18.25 with `openai/gpt-5.4-mini`: passed in ~10 s, 12 events
(`started, reasoning, assistant_text, tool_call, file_changed, tool_result,
usage, final, ended`), 2 steps, 9 688 input / 72 output tokens, `costUSD: 0`
(OAuth subscription billing).
