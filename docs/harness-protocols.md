# Harness protocols — recorded reference (Codex 0.148.0, OpenCode 1.18.25)

> Written for the engineer implementing `HarnessAdapter` (PLAN.md §5) in M4 (`adapters/codex`)
> and M5 (`adapters/opencode`). Everything below was **observed on this machine on 2026-09-02**,
> not read from docs. Raw recordings are in `fixtures/codex/` and `fixtures/opencode/`, each with
> a sibling `*.meta.json` (command line, cwd, exit code, duration, version). All absolute paths in
> the fixtures are scrubbed: the home dir is `/HOME`, the scratch repo root is `/WORK`.
> OpenAI `reasoningEncryptedContent` blobs are replaced with `<REDACTED>`.

Environment: macOS (Darwin 27.0.0, arm64), Node v24.19.0, `codex-cli 0.148.0` at
`/HOME/.local/bin/codex` (ChatGPT login), `opencode 1.18.25` at `/HOME/.opencode/bin/opencode`
(OpenAI OAuth + several other providers connected).

---

## 1. Codex — `codex exec --json`

### 1.1 Launch

```
codex exec --json \
  -C <worktree> \
  -s <read-only|workspace-write|danger-full-access> \
  --skip-git-repo-check \
  [-m <model>] \
  [-c model_reasoning_effort=<minimal|low|medium|high|xhigh|max|ultra|persistent>] \
  [--output-schema <file.json>] \
  [-o <last-message.md>] \
  [--ephemeral] [--add-dir <dir>] [--ignore-user-config] [--ignore-rules] \
  "<prompt>"
```

Hard-won launch details:

- **Always redirect stdin from `/dev/null`.** With a non-TTY stdin Codex prints
  `Reading additional input from stdin...` to stderr and appends whatever it reads as a
  `<stdin>` block to the prompt. It appears on stderr on *every* piped run — it is **not** an
  error; do not treat non-empty stderr as failure. (`codex exec review` printed nothing.)
- `-C/--cd` sets the agent's working root; the child process CWD does not have to match, but set
  both for sanity. Commands the agent runs are executed via `/bin/zsh -lc "..."` (login shell),
  so the user's rc files are on the path.
- `--skip-git-repo-check` is required if the worktree is not a git repo. Worktrees created by
  `git worktree add` *are* repos, so it is belt-and-braces.
- `-o/--output-last-message <FILE>` writes the final assistant message verbatim. **Not written at
  all if the run is cancelled or fails** — do not rely on its existence.
- `-c key=value` takes dotted TOML paths. `-c model_reasoning_effort=low` was **accepted silently**
  (exit 0, nothing on stderr, nothing echoed in the JSONL). There is no way to confirm from the
  stream that the override took effect — validate the value client-side against the
  `ModelReasoningEffort` union in `@openai/codex-sdk` (`minimal | low | medium | high | xhigh |
  max | ultra | persistent`) before spawning.
- MCP: there is no `exec` flag. Either register servers persistently with
  `codex mcp add <name> [--env K=V] -- <cmd> …` / `codex mcp add <name> --url <url>`, or inject
  per-run with `-c 'mcp_servers.<name>.command="…"'` style overrides. `--ignore-user-config`
  drops `~/.codex/config.toml` entirely (auth still uses `CODEX_HOME`) — useful for reproducible
  runs, but then MCP servers must be re-supplied via `-c`.
- Instructions: pass the task as the positional `PROMPT`. Repo-level instructions come from
  `AGENTS.md` in the working root (the agent looked for it unprompted in every recorded run).

### 1.2 Event format (stdout JSONL)

Each stdout line is one JSON object. The union is **not** part of the app-server JSON schema —
it is only typed in `@openai/codex-sdk`'s `ThreadEvent`/`ThreadItem` (see §1.6).

| Line `type` | Payload | Observed |
|---|---|---|
| `thread.started` | `{thread_id: string}` | always first |
| `turn.started` | `{}` | always second |
| `item.started` | `{item: ThreadItem}` | long-running items |
| `item.updated` | `{item: ThreadItem}` | seen only for `todo_list` |
| `item.completed` | `{item: ThreadItem}` | every item |
| `turn.completed` | `{usage: Usage}` | terminal on success |
| `turn.failed` | `{error: {message}}` | **never observed** (typed in SDK) |
| `error` | `{message: string}` | **never observed** (typed in SDK) |

`ThreadItem.type` values (all typed in the SDK; observed ones marked ✅):

`agent_message` ✅, `reasoning`, `command_execution` ✅, `file_change` ✅, `mcp_tool_call`,
`web_search`, `todo_list` ✅, `error`.

Note `reasoning` items were **never emitted** in these runs even though `turn.completed.usage`
reported `reasoning_output_tokens`. Reasoning summaries appear to require
`-c show_raw_agent_reasoning=true` or a model/effort that produces them — assume they may be absent.

Minimal examples (from `fixtures/codex/`):

```jsonc
{"type":"thread.started","thread_id":"01a05f9b-e3c8-7ad0-83e5-03cdec224903"}
{"type":"turn.started"}

{"type":"item.completed","item":{"id":"item_0","type":"agent_message",
 "text":"I'll inspect the existing TypeScript files…"}}

{"type":"item.started","item":{"id":"item_1","type":"command_execution",
 "command":"/bin/zsh -lc \"sed -n '1,200p' src/math.ts\"",
 "aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",
 "command":"/bin/zsh -lc \"sed -n '1,200p' src/math.ts\"",
 "aggregated_output":"export function mul(a: number, b: number): number {\n  return a * b;\n}\n",
 "exit_code":0,"status":"completed"}}

{"type":"item.started","item":{"id":"item_2","type":"file_change",
 "changes":[{"path":"/WORK/codex-b/src/math.test.ts","kind":"update"},
            {"path":"/WORK/codex-b/src/math.ts","kind":"update"}],
 "status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_2","type":"file_change",
 "changes":[…same…],"status":"completed"}}

{"type":"item.completed","item":{"id":"item_1","type":"todo_list","items":[
 {"text":"Inspect repository instructions…","completed":true}]}}

{"type":"turn.completed","usage":{"input_tokens":75708,"cached_input_tokens":54528,
 "cache_write_input_tokens":0,"output_tokens":757,"reasoning_output_tokens":26}}
```

### 1.3 Where things appear

| Nexestra concern | Codex source |
|---|---|
| session ref | `thread.started.thread_id` (resumable via `codex exec resume <id>`; sessions persist in `~/.codex/sessions` unless `--ephemeral`) |
| assistant text | `item.completed` where `item.type === "agent_message"` |
| reasoning | `item.*` with `item.type === "reasoning"` (not observed; may be absent) |
| commands | `command_execution` item: `command` (a full `/bin/zsh -lc …` string, **not** argv), `aggregated_output` (**stdout and stderr merged**, no separation), `exit_code` (`null` while running), `status` |
| file changes | `file_change` item: `changes[].path` (absolute) + `changes[].kind` ∈ `add|delete|update`. **No diff/patch content** — the adapter must compute the diff itself (`git diff` in the worktree). Emitted once per patch application, `status` ∈ `completed|failed` on the completed event |
| tool calls | only MCP calls surface as items (`mcp_tool_call`: `server`, `tool`, `arguments`, `result.content`, `error.message`, `status`). Built-in tools show up as `command_execution` / `file_change`, not generic tool calls |
| permissions | **not present in `exec` mode at all.** `exec` never asks; it runs everything the sandbox allows. Escalation requires `--approve-for-me` (auto-review) or `--dangerously-bypass-approvals-and-sandbox`. Interactive approvals only exist in `codex app-server` (§1.5) |
| usage | only `turn.completed.usage`, once, at the end. Fields are token counts only — **no cost in USD**. Nexestra must price it from the model id |
| final message | last `agent_message` item, and the `-o` file (identical content) |
| structured output | with `--output-schema f.json`, the final `agent_message.item.text` is the JSON **as a string**; the `-o` file holds the same string. There is no separate `structured` field — the adapter must `JSON.parse` it |

### 1.4 Detecting start / final / error / cancel

- **start** → first line, `thread.started`.
- **final** → `turn.completed`; final message = the last `agent_message` seen (or `JSON.parse` of it
  when `--output-schema` was used).
- **error** → typed as `turn.failed` / `error` lines, but **not observed**. Treat a stream that ends
  without `turn.completed` plus a non-zero exit as an error.
- **cancel** → `SIGINT` gives **exit code 1 with no terminal event at all**: the JSONL simply stops
  (fixture `exec-cancelled-sigint.jsonl` ends at `turn.started`), and the `-o` file is never
  created. The adapter must synthesise `{type:"error"|"ended"}` itself from the `AbortSignal`.
- **ended** → process exit. Codes seen: `0` success, `1` cancelled/failed, `2` CLI argument error
  (stderr carries the clap message, stdout is empty).

There is also a nasty orphan case (fixture `exec-truncated-sighup.jsonl`): when the parent shell
was torn down, the JSONL was truncated mid-turn **but the codex child kept running and kept editing
files**. Spawn with a dedicated process group and `kill(-pid)` on cancel; verify the worktree state
after cancel rather than trusting the last event.

### 1.5 `codex app-server` (v2 path — steering & approvals)

- Entry point: `codex app-server` speaks **JSON-RPC over stdio by default**
  (`--listen stdio://`, or `--stdio`). Other transports: `unix://[PATH]`, `ws://IP:PORT`
  (non-loopback WS requires `--ws-auth capability-token|signed-bearer-token` plus a token file).
  `codex app-server daemon` manages a background instance and `codex app-server proxy` pipes stdio
  into the daemon's control socket. No client was built for this research.
- Protocol schema generated into `fixtures/codex/app-server/`:
  `codex app-server generate-json-schema --out <dir>` (**`--out` is mandatory**; without it,
  exit 2, `error: the following required arguments were not provided: --out <DIR>`).
  `codex app-server generate-ts --out <dir>` also works (≈250 `.ts` files, `v1/` + `v2/`).
- Relevant request/notification schemas for approvals — these are the names to look for when M4→M5
  moves off `exec`: `ExecCommandApprovalParams`/`Response`, `ApplyPatchApprovalParams`/`Response`,
  `CommandExecutionRequestApprovalParams`, `FileChangeRequestApprovalParams`,
  `PermissionsRequestApprovalParams`, `McpServerElicitationRequestParams`,
  `ToolRequestUserInputParams`, plus the `ClientRequest` / `ServerRequest` / `ServerNotification`
  unions.
- **The app-server schema does not describe `codex exec --json`.** The exec JSONL format is only
  typed in `@openai/codex-sdk`. Grep of the generated output for `command_execution`, `file_change`,
  `todo_list` returned nothing.

### 1.6 `@openai/codex-sdk`

`npm view @openai/codex-sdk` → **version `0.152.1`** (dist-tags: `latest 0.152.1`,
`alpha 0.153.0-alpha.4`), description *"TypeScript SDK for Codex APIs."*
It **spawns the `codex` CLI and parses the same JSONL over stdio** — it is a typed wrapper around
exactly the protocol in §1.2, not a separate API.

API surface:

```ts
new Codex({ codexPathOverride?, baseUrl?, apiKey?, config?, configOverrides?, env? })
codex.startThread({ model?, sandboxMode?, workingDirectory?, skipGitRepoCheck?,
                    modelReasoningEffort?, networkAccessEnabled?, webSearchMode?,
                    webSearchEnabled?, approvalPolicy?, additionalDirectories?, threadSource? })
codex.resumeThread(id, opts)                  // ~/.codex/sessions
thread.run(input, { outputSchema?, signal? })         // -> { items, finalResponse, usage }
thread.runStreamed(input, opts)                       // -> { events: AsyncGenerator<ThreadEvent> }
```

`input` is a string or `({type:"text",text} | {type:"local_image",path})[]`.
`config` is flattened to dotted `--config k=v`; `configOverrides` are raw `--config` strings.
`env` **replaces** `process.env` for the child.

**Recommendation for M4:** do *not* take the SDK dependency yet. Its version (0.152.x) is ahead of
the installed CLI (0.148.0) and it would spawn whatever `codex` is on PATH anyway. Copy the
`ThreadEvent`/`ThreadItem` types into `packages/core` (they are small and stable-looking) and spawn
the CLI directly with `execa` — that keeps the `AbortSignal`, process group, and stderr handling
under Nexestra's control. Revisit for `app-server`.

### 1.7 `codex exec review`

```
codex exec review --json [--uncommitted | --base <branch> | --commit <sha>] [-o f.md] [PROMPT]
```

- `--uncommitted` **cannot be combined with a PROMPT**:
  `error: the argument '--uncommitted' cannot be used with '[PROMPT]'` (exit 2). Choose one.
- It works fully non-interactively and emits the same JSONL union, including `todo_list` items with
  `item.updated` as the plan progresses.
- **`turn.completed.usage` was all zeros** for the review run
  (`{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0}`)
  while the run took 53 s. Do not trust review usage for budgeting; fall back to a per-run estimate.
- Findings arrived as plain prose in the final `agent_message`, not as structured findings. For the
  cross-review loop in M5, pass `--output-schema` with a findings schema instead of relying on
  review's own formatting.

---

## 2. OpenCode — `opencode serve` (HTTP + SSE)

### 2.1 Launch

```
opencode serve --port <n> --hostname 127.0.0.1 [--print-logs --log-level INFO] [--pure] [--cors …]
```

- `--port 0` picks a free port; the chosen port is only printed on stderr
  (`opencode server listening on http://127.0.0.1:4791`) — parse that line, there is no other way
  to discover it. Use `--print-logs` so the line is emitted.
- Startup also prints `Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.` Set
  `OPENCODE_SERVER_PASSWORD` (+ `OPENCODE_SERVER_USERNAME`) for basic auth if binding beyond
  loopback.
- The server is rooted at its CWD (project detection). Per-request `?directory=` and `?workspace=`
  query params exist on nearly every endpoint, and `POST /session` returns the resolved
  `directory` — that is the hook for worktree-per-task.
- `--pure` skips external plugins (recommended for reproducible runs; the default run loaded ~45
  plugins, all reported as `plugin.added` events that pollute the stream).
- Shutdown: `POST /instance/dispose` (returns `true`) then kill the process.

### 2.2 API discovery

**`GET /doc`** serves the OpenAPI 3.1 spec (there is no `/openapi.json`); saved to
`fixtures/opencode/openapi.json` (468 KB, ~190 operations).

There are **two API surfaces**:

- **v1 (root)** — `/session`, `/event`, `/permission`, `/config`, `/agent`, `/provider`, …
  This is what `@opencode-ai/sdk`'s main export targets and what the recordings use.
- **v2 (`/api`)** — `/api/session`, `/api/event`, `/api/model`, `/api/permission/request`,
  `/api/session/{id}/interrupt`, … newer, exported as `@opencode-ai/sdk/v2`.

> **Use v1 for run telemetry.** `GET /api/event` was subscribed for the whole edit+test run and
> produced only 118 lines, almost all `plugin.added` — it did **not** carry the per-part streaming
> events. `GET /event` produced 700 lines with the full transcript.

Endpoints the adapter needs:

| Purpose | v1 | v2 |
|---|---|---|
| create session | `POST /session` (body: `parentID?`, `title?`, `agent?`, `model{id,providerID,variant?}`, `metadata?`, `permission?`, `workspaceID?`; query `directory`, `workspace`) | `POST /api/session` |
| prompt (sync) | `POST /session/{id}/message` → the **final** assistant message | `POST /api/session/{id}/prompt` |
| prompt (async) | `POST /session/{id}/prompt_async` → **204 No Content** | — |
| events (SSE) | `GET /event` | `GET /api/event`, `GET /api/session/{id}/event` |
| pending permissions | `GET /permission` | `GET /api/permission/request`, `GET /api/session/{id}/permission` |
| answer permission | `POST /session/{id}/permissions/{permissionID}` `{response:"once"\|"always"\|"reject"}`, or `POST /permission/{requestID}/reply` `{reply, message?}` | `POST /api/session/{id}/permission/{requestID}/reply` |
| abort | `POST /session/{id}/abort` → `true` | `POST /api/session/{id}/interrupt` |
| full transcript | `GET /session/{id}/message` | `GET /api/session/{id}/message` |
| diff | `GET /session/{id}/diff`, `GET /vcs/diff`, `GET /vcs/diff/raw` | — |
| models / providers | `GET /provider` (`{all, default, connected}`) | `GET /api/model`, `GET /api/provider` |
| agents | `GET /agent` | `GET /api/agent` |
| tools | `GET /experimental/tool/ids` | — |
| MCP | `GET /mcp`, `POST /mcp` `{name, config:{type:"local",command:[…],cwd?,environment?}\|{type:"remote",…}}`, `POST /mcp/{name}/connect` | — |
| worktrees | `GET|POST|DELETE /experimental/worktree`, `POST /experimental/worktree/reset` | — |

`POST /session/{id}/message` body: `{ parts:[{type:"text",text}|file|agent|subtask],
model?:{providerID,modelID}, agent?, variant?, system?, tools?:{[id]:boolean},
format?:{type:"json_schema",schema,retryCount?}, messageID?, noReply? }` — identical body for
`prompt_async`.

### 2.3 Event format (SSE, `GET /event`)

`text/event-stream`, one `data: {json}` per event, blank-line separated, plus periodic
`: heartbeat` comment lines and `server.heartbeat` events.

Envelope: **v1 `{id, type, properties}`**, **v2 `{id, type, data}`** — note the different payload
key. `id` is `evt_…`.

The spec declares **89 event variants**. Observed in a single edit+test run:

```
message.part.delta 100   plugin.added 90        message.part.updated 52
message.updated 26       session.status 26      server.heartbeat 17
session.updated 11       session.diff 7         catalog.updated 4
file.watcher.updated 4   session.idle 3         reference.updated 2
integration.updated 2    session.created 2      file.edited 2
server.connected 1       session.error 1
```

**Ignore unknown types** — there are ~70 more in the union (`permission.v2.*`, `question.*`,
`pty.*`, `tui.*`, `session.next.*`, `worktree.*`, `workspace.*`, …) and the `session.next.*` family
looks like a next-generation streaming protocol that may replace `message.part.*`.

Minimal examples:

```jsonc
// connection opened
{"id":"evt_…","type":"server.connected","properties":{}}

// lifecycle
{"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"busy"}}}
{"type":"session.status","properties":{"sessionID":"ses_…","status":{
  "type":"retry","attempt":1,"message":"Cannot connect to API…","next":1788310599804}}}
{"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"idle"}}}
{"type":"session.idle","properties":{"sessionID":"ses_…"}}
{"type":"session.error","properties":{"sessionID":"ses_…","error":{
  "name":"APIError","data":{"message":"Cannot connect to API…","isRetryable":true,
  "metadata":{"url":"http://127.0.0.1:20128/v1/chat/completions"}}}}}

// assistant text / reasoning: a part is created, then deltas stream into a named field
{"type":"message.part.updated","properties":{"sessionID":"ses_…","part":{
  "id":"prt_…","messageID":"msg_…","sessionID":"ses_…","type":"reasoning","text":"",
  "time":{"start":…},"metadata":{"openai":{"itemId":"rs_…","reasoningEncryptedContent":"<REDACTED>"}}},
  "time":…}}
{"type":"message.part.delta","properties":{"sessionID":"ses_…","messageID":"msg_…",
  "partID":"prt_…","field":"text","delta":"**Planning file modifications and tests**"}}

// tool call: pending -> running (input filled in) -> completed (output + metadata)
{"type":"message.part.updated","properties":{"part":{"type":"tool","tool":"bash",
  "callID":"call_VIXo…","state":{"status":"running","input":{
    "command":"node --test src/*.test.ts","workdir":"/WORK/repo","timeout":120000},
    "time":{"start":…}}, "id":"prt_…","messageID":"msg_…","sessionID":"ses_…"}}}
{"type":"message.part.updated","properties":{"part":{"type":"tool","tool":"bash",
  "callID":"call_VIXo…","state":{"status":"completed",
    "input":{…},"output":"✔ mul (1.01ms)\n✔ add (0.10ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0\n…",
    "metadata":{"output":"…","exit":0,"truncated":false},
    "title":"node --test src/*.test.ts","time":{"start":…,"end":…}}}}}

// file edits
{"type":"file.edited","properties":{"file":"/WORK/repo/src/math.ts"}}
{"type":"file.watcher.updated","properties":{"file":"/WORK/repo/src/math.ts","event":"change"}}
{"type":"message.part.updated","properties":{"part":{"type":"patch",
  "hash":"ded7ffbc…","files":["/WORK/repo/src/math.test.ts","/WORK/repo/src/math.ts"],
  "id":"prt_…","messageID":"msg_…","sessionID":"ses_…"}}}

// step boundaries carry the usage numbers
{"type":"message.part.updated","properties":{"part":{"type":"step-finish","reason":"tool-calls",
  "snapshot":"ded7ffbc…","tokens":{"total":9288,"input":9166,"output":97,"reasoning":25,
  "cache":{"write":0,"read":0}},"cost":0,"id":"prt_…","messageID":"msg_…"}}}
```

`Part` union (from the spec): `TextPart`, `SubtaskPart`, `ReasoningPart`, `FilePart`, `ToolPart`,
`StepStartPart`, `StepFinishPart`, `SnapshotPart`, `PatchPart`, `AgentPart`, `RetryPart`,
`CompactionPart`.
`ToolState` union: `pending` → `running` → `completed` | `error`
(`error` shape: `{status:"error", input, error: string, metadata?, time:{start,end}}`).
`SessionStatus` union: `{type:"idle"}` | `{type:"busy"}` | `{type:"retry", attempt, message, next, action?}`.

Built-in tool ids (`GET /experimental/tool/ids`):
`invalid, question, bash, read, glob, grep, edit, write, task, webfetch, todowrite, websearch,
skill, apply_patch`.

### 2.4 Message / transcript model — the trap

**One prompt produces many assistant messages, one per model step.** For the recorded run:

```
0 user      : text
1 assistant : step-start, reasoning, text, tool(glob), tool(grep), step-finish
2 assistant : step-start, reasoning, tool(read), tool(read), step-finish
3 assistant : step-start, reasoning, text, tool(apply_patch), step-finish, patch
4 assistant : step-start, reasoning, tool(bash), step-finish
5 assistant : step-start, reasoning, text, step-finish
```

`POST /session/{id}/message` (sync) **returned only message 5** — the last step. Its `time` span was
4 s while the HTTP call took 22 s. **Do not use the sync response as the run transcript**; it is
only good for the final answer. Use the SSE stream, or `GET /session/{id}/message` afterwards.

`AssistantMessage` fields: `id, sessionID, role, time{created,completed}, error?, parentID, modelID,
providerID, mode, agent, path{cwd,root}, summary?, cost, tokens{total,input,output,reasoning,
cache{read,write}}, structured?, variant?, finish?`.

### 2.5 Where things appear

| Nexestra concern | OpenCode source |
|---|---|
| session ref | `POST /session` → `Session.id` (`ses_…`), also `slug`, `projectID`, `directory` |
| assistant text | part `type:"text"`; stream via `message.part.delta {field:"text", delta}` |
| reasoning | part `type:"reasoning"` + same delta mechanism. Provider-encrypted blob lives in `part.metadata.openai.reasoningEncryptedContent` — **never persist or log it** |
| tool calls | part `type:"tool"`: `tool` (name), `callID`, `state.input` (populated at `running`), `state.output`, `state.metadata`, `state.title`, `state.time` |
| commands | the `bash` tool: `state.input.{command,workdir,timeout}`, `state.metadata.exit` (exit code), `state.metadata.output`, `state.metadata.truncated`. **stdout+stderr are merged** into `output` |
| file changes | three signals — `file.edited {file}` (per file, immediate), `message.part.updated` with `part.type:"patch"` `{hash, files[]}` (per patch, no content), and the `apply_patch`/`edit`/`write` tool's `state.metadata.diff` which **does** carry a unified diff. `session.diff` events carry a `diff` array. Prefer the tool `state.metadata.diff` for content and `git diff` in the worktree for truth |
| permissions | `permission.asked` event / `GET /permission` (see §2.6) |
| usage | `step-finish` part: `tokens{total,input,output,reasoning,cache{read,write}}` + `cost` (a **number in USD**, `0` for subscription-billed providers here). Also aggregated on `AssistantMessage.cost/tokens` and cumulatively on `Session.cost/tokens` |
| final message | last assistant message's `text` part; `info.finish` (e.g. `"stop"`) |
| structured output | send `format:{type:"json_schema",schema,retryCount?}` on the prompt; read `AssistantMessage.structured` (untyped) |

### 2.6 Permissions

Default config on this machine is `permission: {"*":"allow"}`, so **nothing is ever asked**. To
force an ask, set a per-session ruleset in the create body (this is the recommended Nexestra
approach — no global config mutation):

```jsonc
POST /session
{"title":"…","permission":[{"permission":"bash","pattern":"*","action":"ask"}]}
// PermissionRule = { permission: string, pattern: string, action: "allow"|"deny"|"ask" }
```

Cycle observed (`fixtures/opencode/permission.*`):

```jsonc
// 1. event
{"type":"permission.asked","properties":{
  "id":"per_05fa2d22d00158GgZ4FbiGCDKh","sessionID":"ses_…","permission":"bash",
  "patterns":["node --test src/*.test.ts"],
  "metadata":{"command":"node --test src/*.test.ts"},
  "always":["node *"],
  "tool":{"messageID":"msg_…","callID":"call_EYhA…"}}}

// 2. GET /permission -> [ …same object… ]

// 3. POST /session/{sessionID}/permissions/per_05fa… {"response":"once"} -> true (HTTP 200)

// 4. event
{"type":"permission.replied","properties":{"sessionID":"ses_…",
  "requestID":"per_…","reply":"once"}}
```

`always[]` is the broader pattern the UI would offer as "always allow". Note there is a parallel
`permission.v2.asked` / `permission.v2.replied` family with a different shape
(`action`, `resources[]`, `save[]`, `source`) — v1 was what fired here. There is also a separate
**question** channel (`question.asked` / `GET /question` / `POST /question/{id}/reply|reject`) for
free-text questions from the agent; wire it to the same Approval queue.

### 2.7 Abort

`POST /session/{id}/abort` → `true` (HTTP 200). Observed sequence:

```jsonc
{"type":"session.error","properties":{"sessionID":"ses_…",
  "error":{"name":"MessageAbortedError","data":{"message":"Aborted"}}}}
{"type":"session.status","properties":{"sessionID":"ses_…","status":{"type":"idle"}}}
{"type":"session.idle","properties":{"sessionID":"ses_…"}}
{"type":"message.updated","properties":{"info":{… "error":{"name":"MessageAbortedError",…}}}}
```

The assistant message keeps `info.error = MessageAbortedError` permanently, so a resumed adapter can
detect the cancel from `GET /session/{id}/message` alone. Error union on `AssistantMessage.error`:
`ProviderAuthError, UnknownError, MessageOutputLengthError, MessageAbortedError,
StructuredOutputError, ContextOverflowError, ContentFilterError, APIError`. **`MessageAbortedError`
is the only one that means "cancelled" — everything else is a genuine failure.**

### 2.8 Errors and retries

When the model provider is unreachable, the HTTP call still returns **200** and the failure is in
`info.error`. Before failing, OpenCode retries **5 times with backoff**, emitting
`session.status {type:"retry", attempt, message, next}` each time (the whole thing took 64 s).
The adapter should surface retries as progress, not as `error`, and only emit `HarnessEvent.error`
on `session.error` / `info.error`. `APIError.data.isRetryable` tells you whether a Nexestra-level
retry is worth it.

### 2.9 `opencode run --format json`

```
opencode run --format json -m <provider>/<model> [--agent a] [--variant high] [--auto]
  [--attach http://host:port] [--dir <path>] [--session ses_…] [--continue] "<prompt>"
```

Exit 0, stderr empty, 23 records for the same task. **Different envelope from SSE:**

```jsonc
{"type":"tool_use","timestamp":1788310970364,"sessionID":"ses_…","part":{ …the same Part object… }}
```

`type` is `step_start | text | tool_use | step_finish` (**snake_case**) while the nested
`part.type` stays kebab-case (`step-start`, `step-finish`). Only **terminal** tool states are
emitted — no `pending`/`running`, so you lose live progress. There is no session-level `error`
record and no final usage summary beyond the last `step_finish.part.tokens`.

Verdict: fine for a one-shot fallback (M5 "fake harness" or a CLI smoke test), **not** for the real
adapter. `opencode serve` + SSE is strictly richer. Note `run --attach <url>` lets it reuse an
already-running server, which is worth remembering for `discover()`.

### 2.10 `@opencode-ai/sdk`

`npm view @opencode-ai/sdk version` → **`1.18.26`** (server here is `1.18.25` — the npm package and
the binary version-drift independently). No README published.

```ts
import { createOpencodeClient, createOpencodeServer, createOpencode } from "@opencode-ai/sdk";
// exports: "." (v1), "./v2", "./client", "./server", "./v2/client", "./v2/types"

createOpencodeServer({ hostname?, port?, signal?, timeout?, config? }): Promise<{url, close()}>
createOpencodeClient({ …heyapi config, directory? }): OpencodeClient
createOpencode(opts): Promise<{ client, server }>
```

`OpencodeClient` is a generated (hey-api) client with namespaces
`session, event, permission, provider, config, agent (app.agents), find, file, vcs, mcp, lsp,
formatter, tool, project, pty, tui, global, instance, path, control` and methods
`create, get, list, update, delete, prompt, promptAsync, abort, fork, share, unshare, summarize,
messages, message, children, todo, diff, revert, unrevert, shell, command, init, subscribe, …`.
Only dependency is `cross-spawn`.

**Recommendation for M5:** use `@opencode-ai/sdk` for the typed request surface, but **subscribe to
`GET /event` yourself** with a raw SSE reader — it is a long-lived stream that must survive
reconnects, and you want unknown-event tolerance in your own hands. Pin the SDK version to the
detected server version's minor line and warn on mismatch in `discover()`.

---

## 3. Proposed mapping to `HarnessEvent` (PLAN.md §5)

### 3.1 Codex (`exec --json`)

| Codex | `HarnessEvent` |
|---|---|
| `thread.started` | `{type:"started", sessionRef: thread_id}` |
| `turn.started` | *(drop, or internal "turn began")* |
| `item.completed` + `item.type==="agent_message"` (non-final) | `{type:"assistant_text", text}` |
| last `agent_message` before `turn.completed` | `{type:"final", message, structured: outputSchema ? JSON.parse(text) : undefined}` |
| `item.*` + `item.type==="reasoning"` | `{type:"reasoning", text}` |
| `item.started` + `command_execution` | `{type:"command", cmd: item.command}` |
| `item.completed` + `command_execution` | `{type:"command", cmd, exitCode: item.exit_code, stdout: item.aggregated_output}` (stderr merged into stdout; leave `stderr` undefined) |
| `item.completed` + `file_change` | one `{type:"file_changed", path, kind}` per `changes[]`; map `update`→`modify`, `add`→`add`, `delete`→`delete` |
| `item.*` + `mcp_tool_call` (`in_progress`) | `{type:"tool_call", name:`${server}/${tool}`, input: arguments, callId: item.id}` |
| `item.completed` + `mcp_tool_call` (`completed`/`failed`) | `{type:"tool_result", callId: item.id, output: result ?? error, ok: status==="completed"}` |
| `item.*` + `todo_list` | `{type:"tool_call", name:"todo_list", input:{items}, callId:item.id}` (or a Nexestra-specific plan event) |
| `item.completed` + `error` | `{type:"error", message: item.message, retryable:false}` |
| `turn.completed` | `{type:"usage", inputTokens: input_tokens, outputTokens: output_tokens}` — compute `costUSD` from the model id; `cached_input_tokens`/`cache_write_input_tokens`/`reasoning_output_tokens` need extra fields or go in metadata |
| `turn.failed` / `error` line | `{type:"error", message, retryable:true}` |
| process exit | `{type:"ended", exitCode}` |
| **no equivalent** | `permission_request` — never emitted by `exec` |

Synthesised by the adapter:
- cancel → on `AbortSignal`, `kill(-pid, "SIGINT")`, then emit `{type:"error", message:"cancelled",
  retryable:false}` + `{type:"ended", exitCode: 1}` when the process exits.
- stream ends without `turn.completed` and exit ≠ 0 → `{type:"error", …}` before `ended`.
- Unparseable JSONL line → log and skip; never throw.

### 3.2 OpenCode (`serve` + SSE)

Filter every event by `properties.sessionID === ourSession` first (the stream is global).

| OpenCode | `HarnessEvent` |
|---|---|
| `POST /session` response | `{type:"started", sessionRef: session.id}` |
| `message.part.updated` `part.type:"text"` / `message.part.delta` `field:"text"` | `{type:"assistant_text", text}` |
| `message.part.updated` `part.type:"reasoning"` / delta `field:"text"` on a reasoning part | `{type:"reasoning", text}` (strip `metadata.openai.reasoningEncryptedContent`) |
| `message.part.updated` `part.type:"tool"`, `state.status:"running"` | `{type:"tool_call", name: part.tool, input: state.input, callId: part.callID}` |
| … `state.status:"completed"` | `{type:"tool_result", callId, output: state.output, ok:true}` |
| … `state.status:"error"` | `{type:"tool_result", callId, output: state.error, ok:false}` |
| tool `bash`, `state.status:"completed"` | additionally `{type:"command", cmd: state.input.command, exitCode: state.metadata.exit, stdout: state.output}` |
| `file.edited` | `{type:"file_changed", path: properties.file, kind:"modify"}` — kind must be inferred (compare against the worktree / `git status`) |
| `message.part.updated` `part.type:"patch"` | fan out to `file_changed` for each `part.files[]` (dedupe against `file.edited`) |
| `permission.asked` | `{type:"permission_request", requestId: properties.id, description: metadata.command ?? permission + " " + patterns.join(" "), risk: heuristic}` |
| `question.asked` | same, routed to the Approval queue |
| `message.part.updated` `part.type:"step-finish"` | `{type:"usage", inputTokens: tokens.input, outputTokens: tokens.output, costUSD: cost}` (accumulate; `tokens.cache.read/write` and `tokens.reasoning` go in metadata) |
| `session.status {type:"retry"}` | *(progress only — do NOT emit `error`)* |
| `session.error` with `error.name === "MessageAbortedError"` | `{type:"error", message:"cancelled", retryable:false}` |
| `session.error` (any other) | `{type:"error", message: error.data.message, retryable: error.data.isRetryable ?? false}` |
| `session.idle` / `session.status {type:"idle"}` | terminal marker → fetch `GET /session/{id}/message`, emit `{type:"final", message: lastTextPart, structured: info.structured}` then `{type:"ended", exitCode: info.error ? 1 : 0}` |
| everything else (~70 types) | log at debug and drop |

`control()` mapping: `cancel` → `POST /session/{id}/abort`; `answer_permission` →
`POST /session/{id}/permissions/{permissionID} {response}`; `steer` → another
`POST /session/{id}/prompt_async` on the same session; `pause` has no native equivalent (abort +
resume with a follow-up prompt is the only option).

`prepare()` mapping for `RunSpec`:

| `RunSpec` | Codex | OpenCode |
|---|---|---|
| `cwd` | `-C <dir>` | `?directory=<dir>` on session create, or one server per workspace |
| `instructions` | positional PROMPT (+ `AGENTS.md` in the worktree) | `parts:[{type:"text",text}]` (+ `system` field, + `AGENTS.md`) |
| `model` | `-m <model>` | `model:{providerID, modelID}` |
| `reasoning` | `-c model_reasoning_effort=<level>` | `variant:"<high|max|minimal|…>"` (provider-specific) |
| `sandbox` | `-s read-only\|workspace-write\|danger-full-access` | **no sandbox concept** — approximate with the `permission` ruleset (`{permission:"bash",pattern:"*",action:"deny"}` ≈ read-only) and by not granting write tools via `tools:{write:false, edit:false, apply_patch:false}` |
| `tools` | not selectable per-run | `tools:{[toolId]: boolean}` on the prompt |
| `mcpServers` | `codex mcp add …` or `-c mcp_servers.*` | `POST /mcp {name, config}` then `POST /mcp/{name}/connect` |
| `skills` | plugins/`AGENTS.md` | `GET /skill`, `skill` tool |
| `outputSchema` | `--output-schema <file>` (JSON string in final message) | `format:{type:"json_schema",schema}` → `info.structured` |
| `timeoutMs` | adapter-side timer + kill process group | adapter-side timer + `POST /abort` |

---

## 4. Version-sensitivity risks

1. **`codex exec --json` has no published schema.** It is not in `codex app-server
   generate-json-schema` output; the only type source is `@openai/codex-sdk`, which is already at
   0.152.1 while the CLI here is 0.148.0. Copy the types, pin `codex --version` in `discover()`,
   and warn on any change. Parser must ignore unknown `type` and unknown `item.type`.
2. **OpenCode has two live API versions plus a third in-flight event family.** The `session.next.*`
   events (24 variants: `session.next.text.delta`, `session.next.tool.called`,
   `session.next.step.started`, …) exist in the 1.18.25 schema but never fired — they look like a
   replacement for `message.part.*`. Build the parser so adding a second mapping table is cheap.
   `/api/*` (v2) endpoints are also documented but the v2 event stream is currently incomplete.
3. **`@opencode-ai/sdk` (1.18.26) and the `opencode` binary (1.18.25) version independently.**
   `discover()` should read `GET /global/health` / the server's `version` field (also present on
   every `Session`) and compare against the pinned SDK.
4. **`plugin.added` noise.** 90 of 700 events in a clean run were plugin registrations from the
   user's global config. Use `--pure` for Nexestra-managed servers so the stream is deterministic
   and fixtures stay stable.
5. **Provider defaults are user config.** The default model here was
   `9router/dsv4/deepseek-v4-flash-0731` pointing at a local proxy on `127.0.0.1:20128` that was not
   running. Nexestra must always send an explicit `model:{providerID, modelID}` and validate it
   against `GET /provider` → `connected[]` in `discover()`.
6. **Absolute paths everywhere.** Both harnesses emit absolute paths in events
   (`file_change.changes[].path`, `file.edited.file`, tool outputs). Relativise against the worktree
   root before storing, or fixtures/UI will leak machine paths.

## 5. What did not work (verbatim errors)

| Attempt | Result |
|---|---|
| `codex app-server generate-json-schema` (no `--out`) | exit 2 — `error: the following required arguments were not provided:\n  --out <DIR>` |
| `codex app-server generate-ts` (no `--out`) | exit 2 — same message |
| `codex exec review --json --uncommitted -o f.md "Review the uncommitted change briefly."` | exit 2 — `error: the argument '--uncommitted' cannot be used with '[PROMPT]'` |
| `codex exec` with a piped/inherited stdin | stderr `Reading additional input from stdin...`; content is appended to the prompt as a `<stdin>` block. Always use `< /dev/null` |
| `codex exec --json` under a backgrounded shell that was torn down | JSONL truncated mid-turn with no terminal event, **but the codex child survived and kept writing files**. Fixture: `exec-truncated-sighup.jsonl` |
| SIGINT to `codex exec` | exit 1, no `turn.failed`/`error` event, `-o` file never created |
| `codex exec review` usage | `turn.completed.usage` all zeros despite a 53 s run |
| `GET /openapi.json` on opencode | not a route; the spec is at `GET /doc` |
| `GET /api/event` as the run stream | connects and heartbeats, but did not carry `message.part.*` for the session. Use `GET /event` |
| `POST /session/{id}/message` as a transcript source | returns only the **last** assistant message; the 4 earlier steps (all the tool calls) are missing |
| Prompting with the machine's default model (`9router/…`) | HTTP 200 but `info.error = {"name":"APIError","data":{"message":"Cannot connect to API: Unable to connect. Is the computer able to access the url?","isRetryable":true,"metadata":{"url":"http://127.0.0.1:20128/v1/chat/completions"}}}` after 5 retries / 64 s |
| Permission request with default config | never fires — global config is `permission: {"*":"allow"}`. Needs a per-session `permission` ruleset |
| `npm view @opencode-ai/sdk readme` | empty — no README is published; the API surface above was read from the shipped `.d.ts` |

## 6. Fixture index

```
fixtures/codex/
  exec-edit-test.jsonl              successful workspace-write edit+test run
  exec-output-schema.jsonl          same + --output-schema; contains the file_change item
  exec-read-only-question.jsonl     -s read-only + -c model_reasoning_effort=low
  exec-cancelled-sigint.jsonl       SIGINT mid-run (silent truncation, exit 1)
  exec-review-uncommitted.jsonl     codex exec review --uncommitted (todo_list, zero usage)
  exec-truncated-sighup.jsonl       negative fixture: stream cut with no terminal event
  app-server/                       generated JSON-RPC protocol schemas + FILELIST.txt
fixtures/opencode/
  openapi.json                      GET /doc, OpenAPI 3.1, ~190 operations
  edit-test.event-v1.sse            full GET /event stream (700 lines, 17 event types)
  edit-test.event-v2.sse            GET /api/event over the same window (near-empty)
  edit-test.messages.json           GET /session/{id}/message — 1 user + 5 assistant messages
  edit-test.prompt-response.json    sync POST response (final message only)
  api-error.prompt-response.json    provider-unreachable failure shape
  permission.event-v1.sse           permission.asked + permission.replied
  permission.list.json              GET /permission payload
  permission.messages.json          transcript after answering "once"
  abort.event-v1.sse                session.error MessageAbortedError + idle
  abort.messages.json               assistant message carrying info.error
  run-format-json.jsonl             opencode run --format json stdout (23 records)
  agents.json, session-create*.json supporting payloads
```

Each `*.jsonl` / `*.sse` / payload has a sibling `*.meta.json` with the exact command line, cwd,
exit code, duration, harness version and date.
