/**
 * Wire types for the OpenCode **v1** HTTP + SSE surface.
 *
 * Hand-written from the OpenAPI 3.1 document served by `GET /doc`
 * (`fixtures/opencode/openapi.json`, OpenCode 1.18.25) and from the recorded
 * event streams. Everything is optional on purpose: the server ships 89 event
 * variants and a 12-member `Part` union, of which this adapter maps a dozen —
 * the parser must never throw on a shape it has not seen
 * (`docs/harness-protocols.md` §2.3, §4).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SSE envelope of the v1 stream: `{id, type, properties}` (v2 uses `data`). */
export interface OpenCodeEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}

/** Event types this adapter maps; everything else is counted and dropped. */
export const HANDLED_OPENCODE_EVENT_TYPES = [
  "server.connected",
  "session.created",
  "session.updated",
  "session.status",
  "session.idle",
  "session.error",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "file.edited",
  "permission.asked",
  "permission.replied",
  "question.asked",
] as const;

export type HandledOpenCodeEventType = (typeof HANDLED_OPENCODE_EVENT_TYPES)[number];

const HANDLED = new Set<string>(HANDLED_OPENCODE_EVENT_TYPES);

export function isHandledOpenCodeEventType(type: unknown): type is HandledOpenCodeEventType {
  return typeof type === "string" && HANDLED.has(type);
}

/**
 * Every `Event` variant declared by the 1.18.25 OpenAPI document (89 of them).
 *
 * Used only to tell "known but irrelevant" (heartbeats, plugin registrations,
 * the `session.next.*` family that never fired) from "this server speaks a
 * dialect we have never seen", which is the signal a version bump changed the
 * protocol. Both are dropped; only the latter is counted as unknown.
 */
export const KNOWN_OPENCODE_EVENT_TYPES = [
  "catalog.updated",
  "command.executed",
  "file.edited",
  "file.watcher.updated",
  "global.disposed",
  "installation.update-available",
  "installation.updated",
  "integration.connection.updated",
  "integration.updated",
  "lsp.updated",
  "mcp.browser.open.failed",
  "mcp.tools.changed",
  "message.part.delta",
  "message.part.removed",
  "message.part.updated",
  "message.removed",
  "message.updated",
  "models-dev.refreshed",
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "plugin.added",
  "project.directories.updated",
  "project.updated",
  "pty.created",
  "pty.deleted",
  "pty.exited",
  "pty.updated",
  "question.asked",
  "question.rejected",
  "question.replied",
  "question.v2.asked",
  "question.v2.rejected",
  "question.v2.replied",
  "reference.updated",
  "server.connected",
  "server.heartbeat",
  "server.instance.disposed",
  "session.compacted",
  "session.created",
  "session.deleted",
  "session.diff",
  "session.error",
  "session.idle",
  "session.next.agent.switched",
  "session.next.compaction.delta",
  "session.next.compaction.ended",
  "session.next.compaction.started",
  "session.next.context.updated",
  "session.next.model.switched",
  "session.next.moved",
  "session.next.prompt.admitted",
  "session.next.prompted",
  "session.next.reasoning.delta",
  "session.next.reasoning.ended",
  "session.next.reasoning.started",
  "session.next.retried",
  "session.next.revert.cleared",
  "session.next.revert.committed",
  "session.next.revert.staged",
  "session.next.shell.ended",
  "session.next.shell.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.step.started",
  "session.next.synthetic",
  "session.next.text.delta",
  "session.next.text.ended",
  "session.next.text.started",
  "session.next.tool.called",
  "session.next.tool.failed",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  "session.next.tool.input.started",
  "session.next.tool.progress",
  "session.next.tool.success",
  "session.status",
  "session.updated",
  "todo.updated",
  "tui.command.execute",
  "tui.prompt.append",
  "tui.session.select",
  "tui.toast.show",
  "vcs.branch.updated",
  "workspace.failed",
  "workspace.ready",
  "workspace.status",
  "worktree.failed",
  "worktree.ready",
] as const;

const KNOWN = new Set<string>(KNOWN_OPENCODE_EVENT_TYPES);

export function isKnownOpenCodeEventType(type: unknown): boolean {
  return typeof type === "string" && KNOWN.has(type);
}

/** `{type:"idle"} | {type:"busy"} | {type:"retry", …}` (`SessionStatus`). */
export interface OpenCodeSessionStatus {
  type: string;
  attempt?: number;
  message?: string;
  next?: number;
  action?: unknown;
}

export interface OpenCodeTokens {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/**
 * `AssistantMessage.error` / `session.error`.
 *
 * `MessageAbortedError` is the only name that means "cancelled"; everything
 * else is a genuine failure (`docs/harness-protocols.md` §2.7).
 */
export interface OpenCodeError {
  name?: string;
  data?: {
    message?: string;
    isRetryable?: boolean;
    metadata?: Record<string, unknown>;
  };
}

export const ABORTED_ERROR_NAME = "MessageAbortedError";

/** One entry of a tool's `state.metadata.files[]` (edit / write / apply_patch). */
export interface OpenCodeToolFile {
  filePath?: string;
  relativePath?: string;
  type?: string;
  patch?: string;
}

/** `ToolState`: `pending` → `running` → `completed` | `error`. */
export interface OpenCodeToolState {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  raw?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

/**
 * The `Part` union, flattened. `type` is one of `text`, `reasoning`, `tool`,
 * `step-start`, `step-finish`, `patch`, `snapshot`, `file`, `agent`, `retry`,
 * `compaction`, `subtask`.
 */
export interface OpenCodePart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  /** `text` / `reasoning` parts. */
  text?: string;
  synthetic?: boolean;
  /** `tool` parts. */
  tool?: string;
  callID?: string;
  state?: OpenCodeToolState;
  /** `patch` parts: absolute paths, no content. */
  files?: string[];
  hash?: string;
  /** `step-start` / `step-finish`. */
  snapshot?: string;
  reason?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
  time?: { start?: number; end?: number };
  /** Carries `openai.reasoningEncryptedContent` — never persist it. */
  metadata?: Record<string, unknown>;
}

export interface OpenCodeMessageInfo {
  id?: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  error?: OpenCodeError;
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
  structured?: unknown;
  variant?: string;
  finish?: string;
}

export interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: OpenCodePart[];
}

export type OpenCodePermissionAction = "allow" | "deny" | "ask";

export interface OpenCodePermissionRule {
  permission: string;
  pattern: string;
  action: OpenCodePermissionAction;
}

export type OpenCodePermissionRuleset = OpenCodePermissionRule[];

/** Reply vocabulary of `POST /session/{id}/permissions/{permissionID}`. */
export type OpenCodePermissionReply = "once" | "always" | "reject";

export interface OpenCodePermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string };
}

export interface OpenCodeSession {
  id: string;
  slug?: string;
  projectID?: string;
  workspaceID?: string;
  directory?: string;
  path?: string;
  parentID?: string;
  title?: string;
  agent?: string;
  version?: string;
  cost?: number;
  tokens?: OpenCodeTokens;
  model?: { id?: string; providerID?: string; variant?: string };
  permission?: OpenCodePermissionRuleset;
  time?: { created?: number; updated?: number };
}

export interface OpenCodeModel {
  id?: string;
  name?: string;
  providerID?: string;
  variants?: Record<string, unknown>;
}

export interface OpenCodeProvider {
  id: string;
  name?: string;
  source?: string;
  models?: Record<string, OpenCodeModel>;
}

export interface OpenCodeProviderList {
  all?: OpenCodeProvider[];
  /** providerID → default model id. */
  default?: Record<string, string>;
  connected?: string[];
}

export interface OpenCodeAgent {
  name: string;
  description?: string;
  mode?: string;
  native?: boolean;
  hidden?: boolean;
  permission?: OpenCodePermissionRuleset;
}

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
}

/** Body of `POST /session`. Note `model.id`, not `model.modelID`. */
export interface OpenCodeSessionCreateBody {
  parentID?: string;
  title?: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  metadata?: Record<string, unknown>;
  permission?: OpenCodePermissionRuleset;
  workspaceID?: string;
}

/**
 * Body of `POST /session/{id}/message` and `POST /session/{id}/prompt_async`.
 * Note `model.modelID` here — the create body spells the same field `id`.
 */
export interface OpenCodePromptBody {
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  system?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  format?: { type: "json_schema"; schema: Record<string, unknown>; retryCount?: number };
  parts: { type: "text"; text: string }[];
}

/** `add | modify | delete`, as `HarnessEvent.file_changed` spells it. */
export type OpenCodeFileChangeKind = "add" | "modify" | "delete";

/** `state.metadata.files[].type` / `SnapshotFileDiff.status` → Nexestra kind. */
export function mapFileChangeKind(value: unknown): OpenCodeFileChangeKind {
  switch (value) {
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
      return "modify";
  }
}
