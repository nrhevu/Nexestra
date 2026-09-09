import type { AgentRun, RunHistoryRequest } from "../shared/contracts.js";
import type { RunHistorySummary } from "./conversation-history.js";

/**
 * Opaque keyset cursor for the workspace run-history list. Ordering is
 * created DESC, then run.id ASC, then threadId ASC so pages stay stable
 * across appends and status updates without offsets.
 */
export interface RunHistoryCursorPayload {
  version: 1;
  workspaceId: string;
  agentId?: string;
  threadId?: string;
  status?: AgentRun["status"];
  limit: number;
  createdAt: string;
  runId: string;
  runThreadId: string;
}

export function encodeRunHistoryCursor(
  input: RunHistoryRequest,
  last: { id: string; threadId: string; createdAt: string },
): string {
  const payload: RunHistoryCursorPayload = {
    version: 1,
    workspaceId: input.workspaceId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.status ? { status: input.status } : {}),
    limit: input.limit,
    createdAt: last.createdAt,
    runId: last.id,
    runThreadId: last.threadId,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

const RUN_HISTORY_CURSOR_KEYS = [
  "version",
  "workspaceId",
  "agentId",
  "threadId",
  "status",
  "limit",
  "createdAt",
  "runId",
  "runThreadId",
] as const;

const RUN_HISTORY_STATUSES = new Set([
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "completed",
  "failed",
  "interrupted",
]);

export function decodeRunHistoryCursor(
  raw: string | undefined,
): RunHistoryCursorPayload | undefined {
  if (raw === undefined) return undefined;
  if (
    raw.length < 2 ||
    raw.length > 2_048 ||
    raw.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(raw) ||
    raw.includes("=")
  ) {
    throw new Error("Invalid run history cursor.");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) {
      throw new Error("Invalid run history cursor.");
    }
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid run history cursor.");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Invalid run history cursor.");
  }
  const payload = decoded as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    keys.length < 6 ||
    keys.length > RUN_HISTORY_CURSOR_KEYS.length ||
    keys.some((key) => !(RUN_HISTORY_CURSOR_KEYS as readonly string[]).includes(key)) ||
    payload.version !== 1 ||
    typeof payload.workspaceId !== "string" ||
    payload.workspaceId.length < 1 ||
    payload.workspaceId.length > 200 ||
    typeof payload.limit !== "number" ||
    !Number.isInteger(payload.limit) ||
    payload.limit < 1 ||
    payload.limit > 100 ||
    typeof payload.createdAt !== "string" ||
    payload.createdAt.length < 1 ||
    payload.createdAt.length > 64 ||
    typeof payload.runId !== "string" ||
    payload.runId.length < 1 ||
    payload.runId.length > 200 ||
    typeof payload.runThreadId !== "string" ||
    payload.runThreadId.length < 1 ||
    payload.runThreadId.length > 200 ||
    (payload.agentId !== undefined &&
      (typeof payload.agentId !== "string" ||
        payload.agentId.length < 1 ||
        payload.agentId.length > 200)) ||
    (payload.threadId !== undefined &&
      (typeof payload.threadId !== "string" ||
        payload.threadId.length < 1 ||
        payload.threadId.length > 200)) ||
    (payload.status !== undefined &&
      (typeof payload.status !== "string" || !RUN_HISTORY_STATUSES.has(payload.status)))
  ) {
    throw new Error("Invalid run history cursor.");
  }
  return payload as unknown as RunHistoryCursorPayload;
}

export function compareRunHistorySummaries(
  left: RunHistorySummary,
  right: RunHistorySummary,
): number {
  const created = compareCodeUnits(right.createdAt, left.createdAt);
  if (created !== 0) return created;
  const id = compareCodeUnits(left.id, right.id);
  if (id !== 0) return id;
  return compareCodeUnits(left.threadId, right.threadId);
}

export function runHistorySummaryAfterCursor(
  summary: RunHistorySummary,
  cursor: RunHistoryCursorPayload,
): boolean {
  const created = compareCodeUnits(summary.createdAt, cursor.createdAt);
  if (created !== 0) return created < 0;
  const id = compareCodeUnits(summary.id, cursor.runId);
  if (id !== 0) return id > 0;
  return compareCodeUnits(summary.threadId, cursor.runThreadId) > 0;
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
