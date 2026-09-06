# Nexestra

Nexestra is a local-first workspace where people and configurable AI agents plan, execute and
review research, documents, design and code. Built on the M9 single-server foundation, it supports:

- create **Worker agents** powered by Codex or OpenCode;
- create **Master agents** using ChatGPT OAuth through Codex CLI or an OpenAI-compatible endpoint;
- chat in shared threads and invoke agents only with an `@handle`;
- save shared documents and Git repositories, then reference them with a `#handle`;
- attach files and images, and browse each thread's indexed files and links;
- manage planned work, repository knowledge, and agents in Taskboard, Knowledge, and Agents.
- maintain shared **Work Briefs** for research, documents, design, code, or mixed work.
- run bounded **Goals**, with pinned scope, durable budgets and independent human review;
- create **Custom surfaces** from reusable table, board, whiteboard and document definitions.

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
├── state.json          # workspace, agent, task, knowledge, assignment, surface and goal metadata
├── credentials.json    # custom API keys, mode 0600
├── artifacts/
│   └── <thread-id>/<artifact-id> # uploaded bytes, mode 0600
├── workspaces/
│   └── <workspace-id>/
│       ├── knowledge/<knowledge-id>/document
│       ├── repositories/<knowledge-id>/source
│       ├── worktrees/<assignment-id>
│       └── assignments/<assignment-id>/outputs/ # general non-Git deliverables
└── threads/
    └── <thread-id>.jsonl  # the thread's shared append-only transcript
```

Set `NEXESTRA_HOME=/another/path` to keep data outside the repository.

## Shared work briefs

Open **Surfaces → Work briefs**, choose a conversation, or create a new one. Record the outcome,
deliverables, constraints, out-of-scope work, open questions and success criteria with a concrete
check for each. Drafts can be incomplete. Optional **Confirm scope** records agreement after the
outcome, outputs and checks are specified and open questions are resolved. Confirmation does not
start work or grant tool permissions.

Briefs work without a Git repository. Every save creates a revision in the conversation's canonical
JSONL; stale updates fail instead of overwriting newer edits. Editing a confirmed brief returns it
to draft. The brief is included when an agent is next mentioned in that conversation. Custom-provider
Masters can use `read_brief` and `draft_brief`; Codex/OpenCode receive the context but do not yet
have that native tool bridge. Use **Work brief** in the conversation tabs to jump to its scope.

The [product vision](docs/PRODUCT-VISION.vi.md), [target harness design](docs/HARNESS-DESIGN.md) and
[roadmap](docs/ROADMAP.md) describe the next steps toward a general-purpose execution workspace.
Worker delegation supports repository worktrees and isolated directories for non-code work.

After **Request changes**, the next assignment receives the prior review and verified copies of
its captured files in `inputs/`. Save the revision in `outputs/`; later edits to the old working
directory do not replace the reviewed source. Failed retries and restarts retain that source.
Changing the task requirements creates a new scope without automatically reusing the old inputs.

Long conversations retain their complete canonical history and exports. Each invocation receives
up to 48,000 characters of recent conversation, with explicit omission markers; pinned work briefs
and assignment contracts remain separate. Custom Masters can use `read_history` to search, page
backward or read a complete message in chunks. Codex/OpenCode also receive the canonical transcript
path. Custom HTTP requests stop before exceeding 240,000 text characters including tool schemas
and accumulated outputs. This is a size guard, not token or spend accounting. See
[conversation context](docs/CONVERSATION-CONTEXT.md) for recovery and limits.

## Goals and shared surfaces

Use **Surfaces → Goals** to create a draft from tasks in one conversation. Review the scope and
limits, then Start. Results wait for your review before the next task or revision runs. Pause and
restart retain usage and the original deadline; a Worker cannot accept its own result. See the
[goal workflow](docs/GOALS.md) for bounds, recovery and current limitations.

Use **Surfaces → Custom surfaces** for a table, board, whiteboard or living document. Import a
definition written by your harness, edit records, select semantic context, or export a reusable
definition. Edits use version checks. These extensions describe data and trusted host views;
they do not execute arbitrary scripts. See the [extension contract and examples](docs/SURFACE-EXTENSIONS.md).

## Invoking agents

Messages without a mention are only saved to the transcript. A message containing `@maya`,
`@codex`, or multiple handles creates one run for each invoked agent. Agent replies are recorded
in the same transcript file. Agent replies do not trigger other agents, which prevents loops.
Transient run failures receive at most two automatic retries; every attempt remains visible in the
canonical thread history.

Messages render as safe GitHub Flavored Markdown with headings, emphasis, lists, task lists, tables,
quotes, links, inline code, fenced code blocks, and KaTeX math. Raw HTML is shown as text instead of
executed, unsafe link schemes are disabled, and external HTTP(S) links open in a new tab. The exact
Markdown source remains unchanged in the shared transcript; bounded context copies mark omissions.

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

Workers run in read-only discussion mode in chat. From a task detail, choose **Start Worker** to
record an explicit request in its linked conversation. Non-code work can use a new directory
without Git; deliverables placed in outputs/ are captured into the conversation and task detail.
For an implementation request, a custom-provider Master
uses `read_tasks` to resume existing work, or `plan` to create new tasks with behavioral criteria,
then calls `delegate` for each task it assigns. Omit the repository for non-Git work.
If the provider tries to return a final answer while planned tasks are still undelegated, the
harness sends it back to the tool loop instead of leaving silent, unassigned work on the board.
Delegation creates `nexestra/<assignment-id>` from the selected `#repository` and checks it out into
an isolated managed worktree. The Worker runs there with write access, verifies its work, and
commits on that branch. Nexestra does not merge or push the branch automatically.

Every assignment is also a durable Worker run. Click any Taskboard card to inspect its assignee,
repository, isolated branch and worktree, current phase, live reasoning, streamed response, and
tool calls. Successful runs move tasks into **In review**. Record evidence for every acceptance
criterion and review notes to accept a result, or request changes to reopen it. A Worker cannot
mark its own task Done. Task requirements are frozen during a run; later edits invalidate that
contract. Completed runs retain the Worker result and tool history in this process view; a task
that was never delegated says so explicitly. The same detail view can edit every task field or
permanently delete the task when no Worker assignment is active. While an assignment is queued or
running, **Stop process** terminates its Codex/OpenCode process group, records the run and unfinished
tools as interrupted, and returns the task to To do so it can be delegated again.

Custom-provider Master agents have a provider-neutral
harness with `list`, `glob`, `grep`, `read`, `edit`, `write`, `bash`, `apply_patch`, `skill`,
`read_brief`, `draft_brief`, `read_tasks`, `plan`, `delegate`, `todowrite`, `webfetch`,
`websearch`, and `question`. LSP is intentionally not
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
  The API key may be left blank for a local endpoint; a non-empty key must contain at least eight
  characters. Remote endpoints must use HTTPS; HTTP is accepted only on loopback. Select one access
  mode for the entire agent. Shell, custom tools, and local MCP servers run as the current local OS
  user, so use Full access only when the provider and extension code are trusted.

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
