import type { ReviewQueueItem, ReviewQueueRequest } from "../shared/contracts.js";

interface ReviewQueueCursorPayload {
  version: 1;
  workspaceId: string;
  agentId?: string;
  threadId?: string;
  limit: number;
  updatedAt: string;
  id: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode(value: string): ReviewQueueCursorPayload | undefined {
  if (
    value.length < 2 ||
    value.length > 2_048 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    value.includes("=")
  ) {
    return undefined;
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return undefined;
    const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (
      keys.some(
        (key) =>
          !["version", "workspaceId", "agentId", "threadId", "limit", "updatedAt", "id"].includes(
            key,
          ),
      ) ||
      parsed.version !== 1 ||
      typeof parsed.workspaceId !== "string" ||
      parsed.workspaceId.length < 1 ||
      parsed.workspaceId.length > 200 ||
      typeof parsed.limit !== "number" ||
      !Number.isInteger(parsed.limit) ||
      parsed.limit < 1 ||
      parsed.limit > 50 ||
      typeof parsed.updatedAt !== "string" ||
      parsed.updatedAt.length < 1 ||
      parsed.updatedAt.length > 64 ||
      typeof parsed.id !== "string" ||
      parsed.id.length < 1 ||
      parsed.id.length > 401 ||
      (parsed.agentId !== undefined &&
        (typeof parsed.agentId !== "string" ||
          parsed.agentId.length < 1 ||
          parsed.agentId.length > 200)) ||
      (parsed.threadId !== undefined &&
        (typeof parsed.threadId !== "string" ||
          parsed.threadId.length < 1 ||
          parsed.threadId.length > 200))
    ) {
      return undefined;
    }
    return {
      version: 1,
      workspaceId: parsed.workspaceId,
      ...(typeof parsed.agentId === "string" ? { agentId: parsed.agentId } : {}),
      ...(typeof parsed.threadId === "string" ? { threadId: parsed.threadId } : {}),
      limit: parsed.limit,
      updatedAt: parsed.updatedAt,
      id: parsed.id,
    };
  } catch {
    return undefined;
  }
}

export function encodeReviewQueueCursor(input: ReviewQueueRequest, item: ReviewQueueItem): string {
  return encode({
    version: 1,
    workspaceId: input.workspaceId,
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    limit: input.limit,
    updatedAt: item.feedback.updatedAt,
    id: item.id,
  });
}

export function decodeReviewQueueCursor(value: string): ReviewQueueCursorPayload | undefined {
  return decode(value);
}

export function reviewQueueItemAfterCursor(
  item: ReviewQueueItem,
  cursor: ReviewQueueCursorPayload,
): boolean {
  return (
    item.feedback.updatedAt < cursor.updatedAt ||
    (item.feedback.updatedAt === cursor.updatedAt && item.id > cursor.id)
  );
}

export function compareReviewQueueItems(left: ReviewQueueItem, right: ReviewQueueItem): number {
  return (
    compareCodeUnits(right.feedback.updatedAt, left.feedback.updatedAt) ||
    compareCodeUnits(left.id, right.id)
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
