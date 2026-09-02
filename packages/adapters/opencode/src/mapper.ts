/**
 * OpenCode v1 SSE event → `HarnessEvent` mapper.
 *
 * Pure and synchronous: `run()` feeds it live events, the contract tests feed
 * it recorded `.sse` fixtures. It never throws on an unknown event type, an
 * unknown `Part` variant or a missing field — the server ships 89 event types
 * and a `session.next.*` family that looks like the next generation of the
 * streaming protocol (`docs/harness-protocols.md` §2.3, §4).
 *
 * The mapping table it implements is `docs/harness-protocols.md` §3.2, refined
 * in `docs/adapters/opencode.md`.
 */

import path from "node:path";
import type { HarnessEvent } from "@nexestra/core";
import type { OpenCodeLogger, OpenCodeUsageTotals } from "./options.js";
import { noopLogger, OPENCODE_WRITE_TOOL_IDS } from "./options.js";
import { permissionDescription, permissionRisk } from "./permission.js";
import {
  ABORTED_ERROR_NAME,
  isHandledOpenCodeEventType,
  isKnownOpenCodeEventType,
  isRecord,
  mapFileChangeKind,
  type OpenCodeError,
  type OpenCodeEvent,
  type OpenCodeFileChangeKind,
  type OpenCodeMessageInfo,
  type OpenCodePart,
  type OpenCodePermissionRequest,
  type OpenCodeTokens,
} from "./types.js";

/** Why the mapper considers the run over. */
export type OpenCodeTerminal = "idle" | "aborted" | "failed";

/** A unified diff carried by an `apply_patch` / `edit` / `write` tool call. */
export interface OpenCodePatchRecord {
  tool: string;
  callId: string;
  diff: string;
}

export interface OpenCodePendingPermission {
  requestId: string;
  sessionId: string;
  /** `permission` for `permission.asked`, `question` for `question.asked`. */
  channel: "permission" | "question";
}

export interface OpenCodeMapperState {
  sessionId: string;
  /** True once the session reported `busy`, i.e. our prompt was admitted. */
  sawBusy: boolean;
  terminal: OpenCodeTerminal | undefined;
  /** `session.status {type:"retry"}` count — progress, never an error. */
  retries: number;
  /** Last non-cancel failure seen on `session.error` / `info.error`. */
  failure: { message: string; retryable: boolean; name: string } | undefined;
  aborted: boolean;
  /** True once a `{type:"error", message:"cancelled"}` has actually been emitted. */
  cancelEmitted: boolean;
  usage: OpenCodeUsageTotals;
  assistantMessageIds: readonly string[];
  /** Concatenated text parts of the last assistant message that produced any. */
  lastAssistantText: string | undefined;
  /** `AssistantMessage.structured` when a `format` was requested. */
  structured: unknown;
  finish: string | undefined;
  fileChanges: readonly { path: string; kind: OpenCodeFileChangeKind }[];
  patches: readonly OpenCodePatchRecord[];
  pendingPermissions: readonly OpenCodePendingPermission[];
  /** Known 1.18.25 events this adapter deliberately drops (heartbeats, plugins…). */
  ignoredEvents: number;
  /** Events whose `type` is not in the 1.18.25 union at all — a protocol change. */
  unknownEvents: number;
  /** Events dropped because they belong to a different session. */
  foreignEvents: number;
}

export interface OpenCodeMapperOptions {
  sessionId: string;
  /** Run cwd; `file_changed.path` is made relative to it when possible. */
  cwd?: string;
  relativisePaths?: boolean;
  /** Emit one event per `message.part.delta` instead of one per completed part. */
  streamDeltas?: boolean;
  logger?: OpenCodeLogger;
}

interface TextPartState {
  type: "text" | "reasoning";
  messageId: string | undefined;
  text: string;
  emitted: boolean;
  /** True when the deltas were forwarded, so completion must not repeat them. */
  streamed: boolean;
}

export class OpenCodeMapper {
  readonly #sessionId: string;
  readonly #cwd: string | undefined;
  readonly #relativise: boolean;
  readonly #streamDeltas: boolean;
  readonly #logger: OpenCodeLogger;

  readonly #messageRoles = new Map<string, string>();
  readonly #parts = new Map<string, TextPartState>();
  readonly #toolCalls = new Set<string>();
  readonly #toolResults = new Set<string>();
  readonly #fileChangeKeys = new Set<string>();
  readonly #errorKeys = new Set<string>();
  readonly #assistantText = new Map<string, string>();
  readonly #assistantOrder: string[] = [];
  readonly #patches: OpenCodePatchRecord[] = [];
  readonly #fileChanges: { path: string; kind: OpenCodeFileChangeKind }[] = [];
  readonly #pendingPermissions = new Map<string, OpenCodePendingPermission>();

  #sawBusy = false;
  #terminal: OpenCodeTerminal | undefined;
  #retries = 0;
  #aborted = false;
  #cancelEmitted = false;
  #failure: { message: string; retryable: boolean; name: string } | undefined;
  #structured: unknown;
  #finish: string | undefined;
  #ignoredEvents = 0;
  #unknownEvents = 0;
  #foreignEvents = 0;
  readonly #usage: OpenCodeUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    steps: 0,
  };

  constructor(options: OpenCodeMapperOptions) {
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#relativise = options.relativisePaths ?? true;
    this.#streamDeltas = options.streamDeltas ?? false;
    this.#logger = options.logger ?? noopLogger;
  }

  get state(): OpenCodeMapperState {
    return {
      sessionId: this.#sessionId,
      sawBusy: this.#sawBusy,
      terminal: this.#terminal,
      retries: this.#retries,
      failure: this.#failure,
      aborted: this.#aborted,
      cancelEmitted: this.#cancelEmitted,
      usage: { ...this.#usage },
      assistantMessageIds: [...this.#assistantOrder],
      lastAssistantText: this.lastAssistantText,
      structured: this.#structured,
      finish: this.#finish,
      fileChanges: [...this.#fileChanges],
      patches: [...this.#patches],
      pendingPermissions: [...this.#pendingPermissions.values()],
      ignoredEvents: this.#ignoredEvents,
      unknownEvents: this.#unknownEvents,
      foreignEvents: this.#foreignEvents,
    };
  }

  /** Text of the last assistant message that produced any — the final answer. */
  get lastAssistantText(): string | undefined {
    for (let index = this.#assistantOrder.length - 1; index >= 0; index -= 1) {
      const id = this.#assistantOrder[index];
      if (id === undefined) continue;
      const text = this.#assistantText.get(id);
      if (text !== undefined && text.trim().length > 0) return text;
    }
    return undefined;
  }

  /** Permission requests this run has raised and not seen answered. */
  pendingPermission(requestId: string): OpenCodePendingPermission | undefined {
    return this.#pendingPermissions.get(requestId);
  }

  /** Map one event. Returns the `HarnessEvent`s it produced, in order. */
  push(event: OpenCodeEvent): HarnessEvent[] {
    if (!isHandledOpenCodeEventType(event.type)) {
      if (isKnownOpenCodeEventType(event.type)) {
        this.#ignoredEvents += 1;
        this.#logger.debug("opencode: dropping an event this adapter does not map", {
          type: event.type,
        });
      } else {
        // Not in the 1.18.25 union at all: the server speaks a newer dialect.
        this.#unknownEvents += 1;
        this.#logger.debug("opencode: skipping unknown event type", { type: event.type });
      }
      return [];
    }
    const properties = event.properties;
    switch (event.type) {
      case "server.connected":
      case "session.created":
      case "session.updated":
      case "permission.replied":
        return [];

      case "session.status":
        return this.#status(properties.status);

      case "session.idle":
        return this.#idle();

      case "session.error":
        return this.#error(properties.error);

      case "message.updated":
        return this.#message(properties.info);

      case "message.part.updated":
        return this.#part(properties.part);

      case "message.part.delta":
        return this.#delta(properties);

      case "file.edited":
        return this.#fileEdited(properties.file);

      case "permission.asked":
        return this.#permissionAsked(properties);

      case "question.asked":
        return this.#questionAsked(properties);
    }
  }

  /**
   * Emit whatever a truncated stream left behind: text and reasoning parts that
   * were streamed but never completed. Called once, at the terminal event.
   */
  flushPending(): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    for (const part of this.#parts.values()) {
      if (part.emitted || part.streamed) continue;
      if (this.#isUserMessage(part.messageId)) continue;
      const text = part.text;
      if (text.trim().length === 0) continue;
      part.emitted = true;
      events.push(
        part.type === "reasoning" ? { type: "reasoning", text } : { type: "assistant_text", text },
      );
    }
    return events;
  }

  /** Mark the run cancelled; used when the abort came from our side. */
  markAborted(): void {
    this.#aborted = true;
    this.#terminal ??= "aborted";
  }

  // ------------------------------------------------------------------ private

  #status(value: unknown): HarnessEvent[] {
    if (!isRecord(value)) return [];
    const type = value.type;
    if (type === "busy") {
      this.#sawBusy = true;
      return [];
    }
    if (type === "retry") {
      // §2.8: OpenCode retries the provider up to 5 times with backoff. This is
      // progress, not a failure — the run only fails if the retries run out.
      this.#retries += 1;
      const message = typeof value.message === "string" ? value.message : "provider retry";
      this.#logger.debug("opencode: provider retry", { attempt: value.attempt, message });
      return [];
    }
    if (type === "idle") return this.#idle();
    return [];
  }

  #idle(): HarnessEvent[] {
    // An `idle` before the session ever went `busy` is the resting state of a
    // freshly created session, not the end of our prompt.
    if (!this.#sawBusy || this.#terminal) return [];
    this.#terminal = this.#aborted ? "aborted" : this.#failure ? "failed" : "idle";
    return [];
  }

  #error(value: unknown): HarnessEvent[] {
    if (!isRecord(value)) return [];
    const error = value as OpenCodeError;
    return this.#failureEvent(error);
  }

  #failureEvent(error: OpenCodeError): HarnessEvent[] {
    const name = error.name ?? "UnknownError";
    const message = error.data?.message ?? name;
    const key = `${name}:${message}`;
    if (this.#errorKeys.has(key)) return [];
    this.#errorKeys.add(key);

    if (name === ABORTED_ERROR_NAME) {
      this.#aborted = true;
      this.#cancelEmitted = true;
      // Codex spells a cancelled run the same way; the orchestrator keys on it.
      return [{ type: "error", message: "cancelled", retryable: false }];
    }
    const retryable = error.data?.isRetryable === true;
    this.#failure = { message, retryable, name };
    return [{ type: "error", message: `${name}: ${message}`, retryable }];
  }

  #message(value: unknown): HarnessEvent[] {
    if (!isRecord(value)) return [];
    const info = value as OpenCodeMessageInfo;
    const id = info.id;
    if (typeof id !== "string") return [];
    if (typeof info.role === "string") this.#messageRoles.set(id, info.role);
    if (info.role !== "assistant") return [];

    if (!this.#assistantText.has(id)) {
      this.#assistantText.set(id, "");
      this.#assistantOrder.push(id);
    }
    if (info.structured !== undefined) this.#structured = info.structured;
    if (typeof info.finish === "string") this.#finish = info.finish;
    // §2.8: a failed provider call still answers HTTP 200; the failure only
    // shows up here (and, for a live run, on `session.error`).
    if (isRecord(info.error)) return this.#failureEvent(info.error as OpenCodeError);
    return [];
  }

  #part(value: unknown): HarnessEvent[] {
    if (!isRecord(value)) return [];
    const part = value as OpenCodePart;
    switch (part.type) {
      case "text":
      case "reasoning":
        return this.#textPart(part, part.type);
      case "tool":
        return this.#toolPart(part);
      case "patch":
        return this.#patchPart(part);
      case "step-finish":
        return this.#stepFinish(part);
      default:
        // step-start, snapshot, agent, retry, compaction, subtask, file…
        return [];
    }
  }

  #textPart(part: OpenCodePart, type: "text" | "reasoning"): HarnessEvent[] {
    const id = part.id;
    if (typeof id !== "string") return [];
    const state = this.#ensurePart(id, type, part.messageID);
    if (typeof part.text === "string") state.text = part.text;
    if (type === "text" && part.messageID) this.#recordAssistantText(part.messageID, state);

    // The user's own prompt arrives as a text part too; it is not model output.
    if (this.#isUserMessage(state.messageId)) return [];
    if (state.emitted || state.streamed) return [];
    // A part is finished when its `time.end` is set; before that the text is
    // still growing and emitting would duplicate it.
    if (part.time?.end === undefined) return [];
    const text = state.text;
    if (text.length === 0) return [];
    state.emitted = true;
    return [type === "reasoning" ? { type: "reasoning", text } : { type: "assistant_text", text }];
  }

  #delta(properties: Record<string, unknown>): HarnessEvent[] {
    const partId = properties.partID;
    const delta = properties.delta;
    // Deltas target a named field; only `text` carries model output, and it is
    // the field of *both* text and reasoning parts.
    if (properties.field !== "text" || typeof partId !== "string" || typeof delta !== "string") {
      return [];
    }
    const state = this.#parts.get(partId);
    if (!state) {
      this.#logger.debug("opencode: delta for an unknown part", { partId });
      return [];
    }
    state.text += delta;
    if (state.type === "text" && state.messageId) this.#recordAssistantText(state.messageId, state);
    if (!this.#streamDeltas || this.#isUserMessage(state.messageId)) return [];
    state.streamed = true;
    return [
      state.type === "reasoning"
        ? { type: "reasoning", text: delta }
        : { type: "assistant_text", text: delta },
    ];
  }

  #toolPart(part: OpenCodePart): HarnessEvent[] {
    const callId = part.callID;
    const tool = part.tool ?? "unknown";
    const state = part.state;
    if (typeof callId !== "string" || !state) return [];
    const status = state.status;
    if (status === "pending") return [];

    const events: HarnessEvent[] = [];
    if (!this.#toolCalls.has(callId)) {
      this.#toolCalls.add(callId);
      events.push({ type: "tool_call", name: tool, input: state.input ?? null, callId });
    }
    if (status !== "completed" && status !== "error") return events;
    if (this.#toolResults.has(callId)) return events;
    this.#toolResults.add(callId);

    if (status === "error") {
      events.push({ type: "tool_result", callId, output: state.error ?? null, ok: false });
      return events;
    }

    events.push({ type: "tool_result", callId, output: state.output ?? null, ok: true });

    const metadata = state.metadata ?? {};
    if (tool === "bash") {
      const input = state.input ?? {};
      const command = typeof input.command === "string" ? input.command : (state.title ?? "");
      const event: HarnessEvent = { type: "command", cmd: command };
      const exit = metadata.exit;
      if (typeof exit === "number") event.exitCode = exit;
      // stdout and stderr are merged by OpenCode; `stderr` stays undefined
      // rather than duplicating the same bytes.
      const output = state.output ?? (typeof metadata.output === "string" ? metadata.output : "");
      if (output.length > 0) event.stdout = output;
      events.push(event);
    }

    events.push(...this.#toolFileChanges(tool, callId, state.input ?? {}, metadata));
    return events;
  }

  #toolFileChanges(
    tool: string,
    callId: string,
    input: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ): HarnessEvent[] {
    const events: HarnessEvent[] = [];
    // The unified diff only exists here — `patch` parts and `file.edited` carry
    // no content at all (§2.5).
    if (typeof metadata.diff === "string" && metadata.diff.length > 0) {
      this.#patches.push({ tool, callId, diff: metadata.diff });
    }
    const files = metadata.files;
    if (Array.isArray(files)) {
      for (const file of files) {
        if (!isRecord(file)) continue;
        const target = file.relativePath ?? file.filePath;
        if (typeof target !== "string") continue;
        const event = this.#fileChange(target, mapFileChangeKind(file.type));
        if (event) events.push(event);
      }
      if (events.length > 0) return events;
    }
    // `edit` / `write` without a `files` list: fall back to the argument. Only
    // write tools qualify — `read` and `grep` take a `filePath`/`path` too.
    if (!OPENCODE_WRITE_TOOL_IDS.includes(tool)) return events;
    const filePath = input.filePath ?? input.path;
    if (typeof filePath === "string" && filePath.length > 0) {
      const event = this.#fileChange(filePath, tool === "write" ? "add" : "modify");
      if (event) events.push(event);
    }
    return events;
  }

  #patchPart(part: OpenCodePart): HarnessEvent[] {
    const files = part.files;
    if (!Array.isArray(files)) return [];
    const events: HarnessEvent[] = [];
    for (const file of files) {
      if (typeof file !== "string") continue;
      const event = this.#fileChange(file, "modify");
      if (event) events.push(event);
    }
    return events;
  }

  #fileEdited(value: unknown): HarnessEvent[] {
    if (typeof value !== "string" || value.length === 0) return [];
    const event = this.#fileChange(value, "modify");
    return event ? [event] : [];
  }

  #stepFinish(part: OpenCodePart): HarnessEvent[] {
    const tokens: OpenCodeTokens = part.tokens ?? {};
    const input = count(tokens.input);
    const output = count(tokens.output);
    this.#usage.inputTokens += input;
    this.#usage.outputTokens += output;
    this.#usage.reasoningTokens += count(tokens.reasoning);
    this.#usage.cacheReadTokens += count(tokens.cache?.read);
    this.#usage.cacheWriteTokens += count(tokens.cache?.write);
    this.#usage.steps += 1;
    const cost = typeof part.cost === "number" && Number.isFinite(part.cost) ? part.cost : 0;
    this.#usage.costUSD += Math.max(cost, 0);
    return [
      { type: "usage", inputTokens: input, outputTokens: output, costUSD: Math.max(cost, 0) },
    ];
  }

  #permissionAsked(properties: Record<string, unknown>): HarnessEvent[] {
    const id = properties.id;
    if (typeof id !== "string") return [];
    const request = properties as unknown as OpenCodePermissionRequest;
    this.#pendingPermissions.set(id, {
      requestId: id,
      sessionId: this.#sessionId,
      channel: "permission",
    });
    return [
      {
        type: "permission_request",
        requestId: id,
        description: permissionDescription(request),
        risk: permissionRisk(request.permission ?? ""),
      },
    ];
  }

  #questionAsked(properties: Record<string, unknown>): HarnessEvent[] {
    const id = properties.id;
    if (typeof id !== "string") return [];
    this.#pendingPermissions.set(id, {
      requestId: id,
      sessionId: this.#sessionId,
      channel: "question",
    });
    const text =
      firstString(properties.text, properties.title, properties.message) ??
      "the agent asked a question";
    return [{ type: "permission_request", requestId: id, description: text, risk: "low" }];
  }

  // ---------------------------------------------------------------- utilities

  #ensurePart(id: string, type: "text" | "reasoning", messageId?: string): TextPartState {
    const existing = this.#parts.get(id);
    if (existing) {
      if (messageId && !existing.messageId) existing.messageId = messageId;
      return existing;
    }
    const created: TextPartState = { type, messageId, text: "", emitted: false, streamed: false };
    this.#parts.set(id, created);
    return created;
  }

  #recordAssistantText(messageId: string, part: TextPartState): void {
    if (this.#isUserMessage(messageId)) return;
    if (!this.#assistantText.has(messageId)) {
      this.#assistantText.set(messageId, "");
      this.#assistantOrder.push(messageId);
    }
    // Re-derive the message text from every one of its text parts, so a delta
    // and the completing update cannot double-count.
    let text = "";
    for (const [, candidate] of this.#parts) {
      if (candidate.messageId !== messageId || candidate.type !== "text") continue;
      if (candidate.text.length === 0) continue;
      text = text.length > 0 ? `${text}\n${candidate.text}` : candidate.text;
    }
    if (text.length === 0) text = part.text;
    this.#assistantText.set(messageId, text);
  }

  #isUserMessage(messageId: string | undefined): boolean {
    return messageId !== undefined && this.#messageRoles.get(messageId) === "user";
  }

  #fileChange(target: string, kind: OpenCodeFileChangeKind): HarnessEvent | undefined {
    const relative = this.#path(target);
    const key = `${relative}:${kind}`;
    if (this.#fileChangeKeys.has(key)) return undefined;
    this.#fileChangeKeys.add(key);
    this.#fileChanges.push({ path: relative, kind });
    return { type: "file_changed", path: relative, kind };
  }

  #path(target: string): string {
    if (!this.#relativise || this.#cwd === undefined || !path.isAbsolute(target)) return target;
    const relative = path.relative(this.#cwd, target);
    if (relative.length === 0) return target;
    if (relative.startsWith("..") || path.isAbsolute(relative)) return target;
    return relative.split(path.sep).join("/");
  }
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
