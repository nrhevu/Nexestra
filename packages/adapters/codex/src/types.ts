/**
 * Native `codex exec --json` stdout types.
 *
 * The `exec` JSONL union is **not** covered by any published schema: it is not
 * in `codex app-server generate-json-schema` output and only exists as
 * `ThreadEvent` / `ThreadItem` inside `@openai/codex-sdk`. These declarations
 * are a hand-copy of that shape, checked against the recordings in
 * `fixtures/codex/` (Codex CLI 0.148.0) — see `docs/harness-protocols.md` §1.2.
 *
 * Everything is optional-ish on purpose: the parser must survive a Codex
 * upgrade that adds fields, renames a status or introduces a new item type.
 */

/** Token accounting from `turn.completed`. Codex reports no cost in USD. */
export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/** `file_change.changes[]` entry. Codex gives no patch content, only the kind. */
export interface CodexFileChange {
  path: string;
  /** `add | delete | update` in 0.148.0. */
  kind: string;
}

/** One `todo_list.items[]` entry. */
export interface CodexTodoItem {
  text: string;
  completed?: boolean;
}

export interface CodexAgentMessageItem {
  id: string;
  type: "agent_message";
  text?: string;
}

export interface CodexReasoningItem {
  id: string;
  type: "reasoning";
  text?: string;
  summary?: string;
}

export interface CodexCommandExecutionItem {
  id: string;
  type: "command_execution";
  /** A full `/bin/zsh -lc "…"` string, not argv. */
  command?: string;
  /** stdout and stderr merged, with no separation. */
  aggregated_output?: string;
  /** `null` while the command is still running. */
  exit_code?: number | null;
  status?: string;
}

export interface CodexFileChangeItem {
  id: string;
  type: "file_change";
  changes?: CodexFileChange[];
  status?: string;
}

export interface CodexMcpToolCallItem {
  id: string;
  type: "mcp_tool_call";
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | string;
  status?: string;
}

export interface CodexWebSearchItem {
  id: string;
  type: "web_search";
  query?: string;
  results?: unknown;
  status?: string;
}

export interface CodexTodoListItem {
  id: string;
  type: "todo_list";
  items?: CodexTodoItem[];
  status?: string;
}

export interface CodexErrorItem {
  id: string;
  type: "error";
  message?: string;
}

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexErrorItem;

/** `item.type` values known to this adapter. Anything else is logged and skipped. */
export const KNOWN_CODEX_ITEM_TYPES = [
  "agent_message",
  "reasoning",
  "command_execution",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "todo_list",
  "error",
] as const;

export type CodexItemType = (typeof KNOWN_CODEX_ITEM_TYPES)[number];

export type CodexThreadEvent =
  | { type: "thread.started"; thread_id?: string }
  | { type: "turn.started" }
  | { type: "item.started"; item?: CodexThreadItem }
  | { type: "item.updated"; item?: CodexThreadItem }
  | { type: "item.completed"; item?: CodexThreadItem }
  | { type: "turn.completed"; usage?: CodexUsage }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string };

/** Top-level `type` values known to this adapter. */
export const KNOWN_CODEX_EVENT_TYPES = [
  "thread.started",
  "turn.started",
  "item.started",
  "item.updated",
  "item.completed",
  "turn.completed",
  "turn.failed",
  "error",
] as const;

export type CodexEventType = (typeof KNOWN_CODEX_EVENT_TYPES)[number];

const KNOWN_EVENT_SET: ReadonlySet<string> = new Set(KNOWN_CODEX_EVENT_TYPES);
const KNOWN_ITEM_SET: ReadonlySet<string> = new Set(KNOWN_CODEX_ITEM_TYPES);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isKnownCodexEventType(type: unknown): type is CodexEventType {
  return typeof type === "string" && KNOWN_EVENT_SET.has(type);
}

export function isKnownCodexItemType(type: unknown): type is CodexItemType {
  return typeof type === "string" && KNOWN_ITEM_SET.has(type);
}

/** `changes[].kind` → the `HarnessEvent.file_changed` vocabulary. */
export function mapFileChangeKind(kind: string | undefined): "add" | "modify" | "delete" {
  switch (kind) {
    case "add":
    case "added":
    case "create":
    case "created":
      return "add";
    case "delete":
    case "deleted":
    case "remove":
    case "removed":
      return "delete";
    default:
      // `update` and anything a future Codex introduces.
      return "modify";
  }
}
