import path from "node:path";
import type { HarnessEvent } from "@nexestra/core";
import { JsonlSplitter } from "./jsonl.js";
import { type CodexLogger, noopLogger } from "./options.js";
import {
  type CodexFileChange,
  type CodexThreadEvent,
  type CodexThreadItem,
  type CodexTodoItem,
  type CodexUsage,
  isKnownCodexEventType,
  isKnownCodexItemType,
  isRecord,
  mapFileChangeKind,
} from "./types.js";

/** Messages that make a Nexestra-level retry worthwhile. */
const RETRYABLE_PATTERNS: readonly RegExp[] = [
  /\brate.?limit/i,
  /\b(429|500|502|503|504)\b/,
  /\boverloaded\b/i,
  /\btemporar(y|ily)\b/i,
  /\btimed? ?out\b/i,
  /\btimeout\b/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bETIMEDOUT\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /socket hang up/i,
  /connection (reset|closed|refused|error)/i,
  /stream (error|disconnected|closed)/i,
  /network error/i,
];

/** Messages that will fail again no matter how often we retry. */
const FATAL_PATTERNS: readonly RegExp[] = [
  /\b(401|403)\b/,
  /unauthori[sz]ed/i,
  /not logged in/i,
  /invalid api key/i,
  /authentication/i,
  /usage limit/i,
  /quota/i,
  /insufficient/i,
  /unrecognized|unexpected argument|invalid value/i,
];

/** Heuristic `HarnessEvent.error.retryable` classification for a Codex message. */
export function classifyCodexError(message: string): boolean {
  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(message)) return false;
  }
  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) return true;
  }
  return false;
}

export interface CodexParserOptions {
  /** Run cwd; `file_changed.path` is made relative to it when possible. */
  cwd?: string;
  /** Emit relative paths in `file_changed`. Default `true`. */
  relativisePaths?: boolean;
  /** Set when `--output-schema` was passed, so the final message is JSON. */
  hasOutputSchema?: boolean;
  logger?: CodexLogger;
}

export interface CodexParserState {
  threadId: string | undefined;
  turnStarted: boolean;
  turnCompleted: boolean;
  turnFailed: boolean;
  usage: CodexUsage | undefined;
  agentMessages: readonly string[];
  fileChanges: readonly { path: string; kind: "add" | "modify" | "delete" }[];
  todos: readonly CodexTodoItem[];
  /** Native lines the parser did not recognise (type or item.type). */
  unknownLines: number;
  /** Lines that were not valid JSON at all. */
  malformedLines: number;
  /** The half-written line left over after a truncated stream, if any. */
  truncatedTail: string | undefined;
}

/**
 * Incremental `codex exec --json` stdout → `HarnessEvent[]` mapper.
 *
 * Pure and synchronous: `run()` feeds it chunks, the contract tests feed it
 * whole fixtures. It never throws on malformed or unknown input — the mapping
 * table lives in `docs/harness-protocols.md` §3.1.
 */
export class CodexStreamParser {
  readonly #splitter = new JsonlSplitter();
  readonly #logger: CodexLogger;
  readonly #cwd: string | undefined;
  readonly #relativise: boolean;
  readonly #hasOutputSchema: boolean;

  #threadId: string | undefined;
  #turnStarted = false;
  #turnCompleted = false;
  #turnFailed = false;
  #usage: CodexUsage | undefined;
  #agentMessages: string[] = [];
  #fileChanges: { path: string; kind: "add" | "modify" | "delete" }[] = [];
  #todos: CodexTodoItem[] = [];
  #unknownLines = 0;
  #malformedLines = 0;
  #truncatedTail: string | undefined;
  /** `command_execution` items already reported at `item.started`. */
  readonly #startedCommands = new Set<string>();

  constructor(options: CodexParserOptions = {}) {
    this.#logger = options.logger ?? noopLogger;
    this.#cwd = options.cwd;
    this.#relativise = options.relativisePaths ?? true;
    this.#hasOutputSchema = options.hasOutputSchema ?? false;
  }

  /** Feed a stdout chunk; returns the events it produced, in order. */
  push(chunk: string): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const line of this.#splitter.push(chunk)) {
      events.push(...this.#line(line));
    }
    return events;
  }

  /**
   * Feed the whole stream at once. Convenience for the contract tests; a
   * trailing partial line is treated exactly as it is at runtime.
   */
  pushAll(text: string): HarnessEvent[] {
    return [...this.push(text), ...this.flush()];
  }

  /** Consume the trailing partial line, if the stream was cut mid-line. */
  flush(): HarnessEvent[] {
    const rest = this.#splitter.flush();
    if (rest === undefined) return [];
    const parsed = safeJsonParse(rest);
    if (parsed === undefined) {
      this.#truncatedTail = rest;
      this.#malformedLines += 1;
      this.#logger.warn("codex: dropping truncated JSONL tail", { bytes: rest.length });
      return [];
    }
    return this.#event(parsed);
  }

  get state(): CodexParserState {
    return {
      threadId: this.#threadId,
      turnStarted: this.#turnStarted,
      turnCompleted: this.#turnCompleted,
      turnFailed: this.#turnFailed,
      usage: this.#usage,
      agentMessages: this.#agentMessages,
      fileChanges: this.#fileChanges,
      todos: this.#todos,
      unknownLines: this.#unknownLines,
      malformedLines: this.#malformedLines,
      truncatedTail: this.#truncatedTail,
    };
  }

  get threadId(): string | undefined {
    return this.#threadId;
  }

  /** Last `agent_message` seen — the final answer, per §1.3. */
  get lastAgentMessage(): string | undefined {
    return this.#agentMessages.at(-1);
  }

  /** `JSON.parse` of the final message when `--output-schema` was used. */
  parseStructuredOutput(message?: string): unknown {
    if (!this.#hasOutputSchema) return undefined;
    const text = message ?? this.lastAgentMessage;
    if (text === undefined) return undefined;
    const parsed = safeJsonParse(text);
    if (parsed === undefined) {
      this.#logger.warn("codex: --output-schema was set but the final message is not JSON");
      return undefined;
    }
    return parsed;
  }

  // ------------------------------------------------------------------ private

  #line(line: string): HarnessEvent[] {
    if (line.trim().length === 0) return [];
    const parsed = safeJsonParse(line);
    if (parsed === undefined) {
      this.#malformedLines += 1;
      this.#logger.warn("codex: skipping non-JSON stdout line", { line: truncate(line, 200) });
      return [];
    }
    return this.#event(parsed);
  }

  #event(value: unknown): HarnessEvent[] {
    if (!isRecord(value)) {
      this.#malformedLines += 1;
      this.#logger.warn("codex: skipping non-object stdout line");
      return [];
    }
    const type = value.type;
    if (!isKnownCodexEventType(type)) {
      this.#unknownLines += 1;
      this.#logger.debug("codex: skipping unknown event type", { type });
      return [];
    }
    const event = value as unknown as CodexThreadEvent;
    switch (event.type) {
      case "thread.started": {
        this.#threadId = event.thread_id ?? undefined;
        return [{ type: "started", sessionRef: this.#threadId ?? "" }];
      }
      case "turn.started": {
        this.#turnStarted = true;
        return [];
      }
      case "turn.completed": {
        this.#turnCompleted = true;
        this.#usage = event.usage ?? {};
        return [
          {
            type: "usage",
            inputTokens: nonNegative(event.usage?.input_tokens),
            outputTokens: nonNegative(event.usage?.output_tokens),
          },
        ];
      }
      case "turn.failed": {
        this.#turnFailed = true;
        const message = event.error?.message ?? "codex turn failed";
        return [{ type: "error", message, retryable: classifyCodexError(message) }];
      }
      case "error": {
        const message = event.message ?? "codex reported an error";
        this.#turnFailed = true;
        return [{ type: "error", message, retryable: classifyCodexError(message) }];
      }
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.#item(event.type, event.item);
    }
  }

  #item(phase: "item.started" | "item.updated" | "item.completed", item: unknown): HarnessEvent[] {
    if (!isRecord(item)) {
      this.#unknownLines += 1;
      this.#logger.debug("codex: item event without an item payload", { phase });
      return [];
    }
    if (!isKnownCodexItemType(item.type)) {
      this.#unknownLines += 1;
      this.#logger.debug("codex: skipping unknown item type", { type: item.type, phase });
      return [];
    }
    const known = item as unknown as CodexThreadItem;
    const callId = typeof known.id === "string" ? known.id : "unknown";
    const completed = phase === "item.completed";

    switch (known.type) {
      case "agent_message": {
        if (!completed) return [];
        const text = known.text ?? "";
        this.#agentMessages.push(text);
        return [{ type: "assistant_text", text }];
      }

      case "reasoning": {
        if (!completed) return [];
        const text = known.text ?? known.summary ?? "";
        return text.length > 0 ? [{ type: "reasoning", text }] : [];
      }

      case "command_execution": {
        const cmd = known.command ?? "";
        if (!completed) {
          // `item.updated` can repeat while a command runs; announce it once.
          if (this.#startedCommands.has(callId)) return [];
          this.#startedCommands.add(callId);
          return [{ type: "command", cmd }];
        }
        const event: HarnessEvent = { type: "command", cmd };
        if (typeof known.exit_code === "number") event.exitCode = known.exit_code;
        // Codex merges stdout and stderr into `aggregated_output`; `stderr`
        // stays undefined rather than duplicating the same bytes.
        if (typeof known.aggregated_output === "string") event.stdout = known.aggregated_output;
        return [event];
      }

      case "file_change": {
        if (!completed) return [];
        const changes: CodexFileChange[] = Array.isArray(known.changes) ? known.changes : [];
        const events: HarnessEvent[] = [];
        for (const change of changes) {
          if (!isRecord(change) || typeof change.path !== "string") continue;
          const kind = mapFileChangeKind(change.kind);
          const filePath = this.#path(change.path);
          this.#fileChanges.push({ path: filePath, kind });
          events.push({ type: "file_changed", path: filePath, kind });
        }
        return events;
      }

      case "mcp_tool_call": {
        const name = `${known.server ?? "mcp"}/${known.tool ?? "unknown"}`;
        if (!completed) {
          return [{ type: "tool_call", name, input: known.arguments ?? null, callId }];
        }
        const ok = known.status === undefined || known.status === "completed";
        const output = ok ? (known.result ?? null) : (known.error ?? known.result ?? null);
        return [{ type: "tool_result", callId, output, ok }];
      }

      case "web_search": {
        if (!completed) {
          return [
            { type: "tool_call", name: "web_search", input: { query: known.query ?? "" }, callId },
          ];
        }
        return [{ type: "tool_result", callId, output: known.results ?? null, ok: true }];
      }

      case "todo_list": {
        const items: CodexTodoItem[] = Array.isArray(known.items) ? known.items : [];
        this.#todos = items;
        if (phase === "item.started") {
          return [{ type: "tool_call", name: "todo_list", input: { items }, callId }];
        }
        // `item.updated` / `item.completed` report plan progress.
        return [{ type: "tool_result", callId, output: { items, done: completed }, ok: true }];
      }

      case "error": {
        if (!completed) return [];
        const message = known.message ?? "codex item error";
        return [{ type: "error", message, retryable: classifyCodexError(message) }];
      }
    }
  }

  #path(absolute: string): string {
    if (!this.#relativise || this.#cwd === undefined) return absolute;
    const relative = path.relative(this.#cwd, absolute);
    if (relative.length === 0) return absolute;
    if (relative.startsWith("..") || path.isAbsolute(relative)) return absolute;
    return relative;
  }
}

function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
