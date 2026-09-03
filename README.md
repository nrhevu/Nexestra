# Nexestra

Nexestra is a local-first workspace where people can chat and work with coding agents.
Milestone M9 is a fresh rebuild focused on two primary workflows:

- create **Worker agents** powered by Codex or OpenCode;
- create **Master agents** using ChatGPT OAuth through Codex CLI or an OpenAI-compatible endpoint;
- chat in shared threads and invoke agents only with an `@handle`;
- manage tasks and agents in the first two surfaces: Taskboard and Agents.

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
├── state.json          # workspace, agent, thread, and task metadata
├── credentials.json    # custom API keys, mode 0600
└── threads/
    └── <thread-id>.jsonl  # the thread's shared append-only transcript
```

Set `NEXESTRA_HOME=/another/path` to keep data outside the repository.

## Invoking agents

Messages without a mention are only saved to the transcript. A message containing `@maya`,
`@codex`, or multiple handles creates one run for each invoked agent. Agent replies are recorded
in the same transcript file. Agent replies do not trigger other agents, which prevents loops.

Workers run in read-only discussion mode. Custom-provider Master agents have a provider-neutral
harness with `list`, `glob`, `grep`, `read`, `edit`, `write`, `bash`, `apply_patch`, `skill`,
`todowrite`, `webfetch`, `websearch`, and `question`. LSP is intentionally not included. Questions
pause in the thread until the user answers; approval-gated tools pause until the user allows or
denies the call. The Taskboard currently organizes work but does not dispatch agents automatically.

## Master harness configuration

Optional workspace configuration lives in `nexestra.config.json`. It can tighten an agent's saved
permissions, add search ignores, choose the hosted web-search backend, add custom tool directories,
and configure local or remote MCP servers. Wildcards apply to normalized custom and MCP names; an
MCP tool named `lookup` on server `docs` is exposed as `docs_lookup`. Configuration can make a saved
agent policy stricter, but cannot silently loosen it.

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

Repository custom tools are discovered in `.opencode/tools/` and `.nexestra/tools/`; user tools are
also discovered in the OpenCode config directory. A `.js`, `.mjs`, `.cjs`, or Node-compatible `.ts`
module may export one or more objects with `description`, either a Zod `args` schema or JSON Schema
`parameters`, and an async `execute(args, context)` function. Default exports use the filename as
their tool name; named exports use `<filename>_<export>`.

```js
// .opencode/tools/greet.mjs
export default {
  description: "Greet a person.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"]
  },
  execute(args) {
    return `Hello ${args.name}`;
  }
};
```

`glob`, `grep`, and `list` respect `.gitignore`, `.ignore`, and configured ignore patterns while
always excluding Nexestra data and credential files. `webfetch` blocks private-network targets,
validates redirects, and caps responses. `websearch` uses Exa by default or Parallel when selected;
their optional `EXA_API_KEY` or `PARALLEL_API_KEY` environment variables are supported.

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
  creation form. Choose read-only or build access; build uses Codex's workspace-write sandbox and
  automatic approval review. Codex CLI manages OAuth tokens; Nexestra never reads or stores them.
- **Custom:** enter an API root and model, then select OpenAI Chat Completions or OpenAI Responses.
  The API key may be left blank for a local endpoint. Remote endpoints must use HTTPS; HTTP is
  accepted only on loopback. File, shell, skill, todo, web, question, and extension permissions can
  each be allowed, approved per call, or denied. Shell, custom tools, and local MCP servers run as
  the current local OS user, so keep them on Ask unless the endpoint and extension code are trusted.

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
