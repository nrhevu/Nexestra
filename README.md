# Nexestra

Nexestra is a local-first workspace where people can chat and work with coding agents.
Milestone M9 is a fresh rebuild focused on two primary workflows:

- create **Worker agents** powered by Codex or OpenCode;
- create **Master agents** using ChatGPT OAuth through Codex CLI or an OpenAI-compatible endpoint;
- chat in shared threads and invoke agents only with an `@handle`;
- save shared documents and Git repositories, then reference them with a `#handle`;
- attach files and images, and browse each thread's indexed files and links;
- manage planned work, repository knowledge, and agents in Taskboard, Knowledge, and Agents.

Workspaces are selected from the far-left rail. Each workspace has its own threads, agents, and
tasks; Threads, Surfaces, and Settings live in the navigation panel beside that rail. Creating a
workspace also creates its initial `general` thread.

## Run locally

Requires Node.js 24+ and pnpm 11.

```bash
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. The backend binds only to loopback on port `4242`.
Change the port with `NEXESTRA_PORT`.

By default, data is stored in `.nexestra/` in the running repository:

```text
.nexestra/
├── state.json          # workspace, agent, thread, task, knowledge, and assignment metadata
├── credentials.json    # custom API keys, mode 0600
├── artifacts/
│   └── <thread-id>/<artifact-id> # uploaded bytes, mode 0600
├── workspaces/
│   └── <workspace-id>/
│       ├── knowledge/<knowledge-id>/document
│       ├── repositories/<knowledge-id>/source
│       └── worktrees/<assignment-id>
└── threads/
    └── <thread-id>.jsonl  # the thread's shared append-only transcript
```

Set `NEXESTRA_HOME=/another/path` to keep data outside the repository.

## Invoking agents

Messages without a mention are only saved to the transcript. A message containing `@maya`,
`@codex`, or multiple handles creates one run for each invoked agent. Agent replies are recorded
in the same transcript file. Agent replies do not trigger other agents, which prevents loops.

Messages render as safe GitHub Flavored Markdown with headings, emphasis, lists, task lists, tables,
quotes, links, inline code, fenced code blocks, and KaTeX math. Raw HTML is shown as text instead of
executed, unsafe link schemes are disabled, and external HTTP(S) links open in a new tab. The exact
Markdown source remains unchanged in the shared transcript and agent context.

While an agent is active, the thread receives a live event stream with its current phase, tool
activity, runtime-emitted reasoning, and in-progress answer. Reasoning is collapsed behind a
**Thinking** disclosure. Custom OpenAI-compatible providers stream response and reasoning deltas
through their native SSE protocols. Codex and OpenCode stream the JSONL lifecycle events their CLIs
expose. When a run completes successfully, transient thinking and tool activity disappear so the
thread shows only the final answer. Durable tool records remain in the canonical transcript for
recovery and audit; transient reasoning and text deltas are never persisted as chat messages.

The composer accepts up to 10 files per message, with a 20 MB per-file and 50 MB combined limit.
Safe raster images render inline; other files download rather than execute in the browser. Every
thread has a **Files & links** view with search and type filters. Nexestra automatically indexes
HTTP(S) links in user and agent messages, plus existing workspace files referenced by Markdown
links or inline-code paths. Uploaded files remain immutable; workspace-file references always open
the current file contents.

Artifacts on the triggering message are passed to the invoked agent. Codex receives image inputs,
OpenCode receives file inputs, and custom OpenAI-compatible providers receive bounded text-file
content and safe raster images in their native multimodal request shape.

The **Knowledge** surface stores workspace-scoped documents and Git repositories. Typing `#` in
the composer opens the knowledge picker. Text documents are included as bounded context; binary
documents are exposed by their managed local path. Repository URLs may use HTTPS or SSH, and local
Git paths are also accepted. URLs containing embedded credentials are rejected. Click a Knowledge
card to inspect its details, edit its name, `#handle`, and description, download a stored document,
or permanently delete it. Replacing document bytes or a repository source uses delete-and-create.

Workers run in read-only discussion mode. For an implementation request, a custom-provider Master
must call `plan` to create durable Taskboard tasks and then call `delegate` for each task it assigns.
If the provider tries to return a final answer while planned tasks are still undelegated, the
harness sends it back to the tool loop instead of leaving silent, unassigned work on the board.
Delegation creates `nexestra/<assignment-id>` from the selected `#repository` and checks it out into
an isolated managed worktree. The Worker runs there with write access, verifies its work, and
commits on that branch. Nexestra does not merge or push the branch automatically.

Every assignment is also a durable Worker run. Click any Taskboard card to inspect its assignee,
repository, isolated branch and worktree, current phase, live reasoning, streamed response, and
tool calls. Completed cards retain the Worker result and tool history in this process view; a task
that was never delegated says so explicitly. The same detail view can edit every task field or
permanently delete the task when no Worker assignment is active.

Custom-provider Master agents have a provider-neutral
harness with `list`, `glob`, `grep`, `read`, `edit`, `write`, `bash`, `apply_patch`, `skill`,
`plan`, `delegate`, `todowrite`, `webfetch`, `websearch`, and `question`. LSP is intentionally not
included. Questions
pause in the thread until the user answers; approval-gated tools pause until the user allows or
denies the call.

Each Master has one access mode instead of separate settings for every tool:

- **Ask for permission:** reads, skills, todos, and questions run directly; edits, shell commands,
  web access, and extensions pause for approval.
- **Auto:** built-in tools run automatically inside the normal harness boundaries; custom and MCP
  tools still pause for approval.
- **Full access:** every tool runs without approval. Fixed credential, path, network, timeout, and
  output protections still apply to the provider-neutral harness.

## Master harness configuration

Optional workspace configuration lives in `nexestra.config.json`. It can tighten the selected
access mode, add search ignores, choose the hosted web-search backend, add custom tool directories,
and configure local or remote MCP servers. Wildcards apply to normalized custom and MCP names; an
MCP tool named `lookup` on server `docs` is exposed as `docs_lookup`. Configuration can make an
access policy stricter, but cannot silently loosen it. Permission rules use OpenCode's ordered
matching semantics: when multiple patterns match, the last matching rule wins.

```json
{
  "permission": {
    "deploy_*": "deny",
    "docs_*": "ask"
  },
  "ignore": ["generated/**", "coverage/**"],
  "websearch": { "provider": "exa" },
  "customTools": { "directories": ["tools/nexestra"] },
  "mcp": {
    "timeout": { "startup": 30000, "catalog": 30000, "execution": 43200000 },
    "servers": {
      "localdocs": {
        "type": "local",
        "command": ["node", "tools/docs-server.mjs"],
        "environment": { "DOCS_TOKEN": "{env:DOCS_TOKEN}" },
        "timeout": 30000
      },
      "remote": {
        "type": "remote",
        "url": "https://mcp.example.com/service",
        "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" }
      }
    }
  }
}
```

Repository custom tools are discovered in `.opencode/tool/`, `.opencode/tools/`,
`.nexestra/tool/`, and `.nexestra/tools/`; user tools are also discovered in the OpenCode config
directory. A `.js`, `.mjs`, `.cjs`, or Node-compatible `.ts` module may use the official
`@opencode-ai/plugin` helper or export an equivalent object. Raw Zod `args` shapes and JSON Schema
`parameters` are accepted. Default exports use the filename as their tool name; named exports use
`<filename>_<export>`. The execution context includes OpenCode-compatible `sessionID`, `messageID`,
`agent`, `directory`, `worktree`, `abort`, `metadata`, and `ask` members.

```js
// .opencode/tool/greet.mjs
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Greet a person.",
  args: {
    name: tool.schema.string()
  },
  async execute(args) {
    return `Hello ${args.name}`;
  }
});
```

`glob`, `grep`, and `list` respect `.gitignore`, `.ignore`, and configured ignore patterns while
always excluding Nexestra data and credential files. `webfetch` blocks private-network targets,
validates redirects, and caps responses. `websearch` uses Exa by default or Parallel when selected;
their optional `EXA_API_KEY` or `PARALLEL_API_KEY` environment variables are supported. The file
tools accept OpenCode's `filePath`, `oldString`, `newString`, `replaceAll`, and shell `workdir`
arguments while retaining legacy Nexestra aliases. Oversized tool output is previewed and the full
redacted result is saved under `.nexestra/runs/tool-output/` for continuation with `read`.

## Agent lifecycle

Disabling an agent removes it from the mention picker without deleting its configuration. Archiving
also keeps the profile and any saved credential, and archived agents remain available in the Agent
management surface for permanent deletion. Deleting an idle agent removes its profile and saved
credential, unassigns its current tasks, and releases its handle for reuse. Shared thread history is
append-only, so existing messages remain attributed to the deleted agent. Agents with queued or
running work cannot be deleted until that work finishes.

When creating a Worker, the model and reasoning effort are optional. Leaving either field blank
uses the selected harness default. Codex receives the model and `model_reasoning_effort` overrides;
OpenCode receives `--model` (in `provider/model` form) and the provider-specific `--variant`.

## Provider

- **ChatGPT OAuth:** install Codex CLI and run `codex login`, or click Connect in the Master
  creation form. Ask mode is read-only, Auto uses Codex's workspace-write sandbox and automatic
  approval review, and Full access bypasses the Codex sandbox and approvals. Codex CLI manages
  OAuth tokens; Nexestra never reads or stores them.
- **Custom:** enter an API root and model, then select OpenAI Chat Completions or OpenAI Responses.
  The API key may be left blank for a local endpoint. Remote endpoints must use HTTPS; HTTP is
  accepted only on loopback. Select one access mode for the entire agent. Shell, custom tools, and
  local MCP servers run as the current local OS user, so use Full access only when the provider and
  extension code are trusted.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# or run everything:
pnpm check
```

Default tests do not call paid providers and do not require a Codex or OpenCode account.

See the [architecture](docs/ARCHITECTURE.md) and [current limitations](docs/ARCHITECTURE.md#known-gaps).
