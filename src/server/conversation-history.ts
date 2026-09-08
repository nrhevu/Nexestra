import { open, readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

/**
 * Bounded conversation-history reader. The canonical JSONL transcript stays the
 * single source of truth; this module keeps only an in-memory byte-offset index
 * (primed during startup, extended after durable appends) plus tiny positional
 * read helpers. History requests never read the whole file.
 */

export const HISTORY_MAX_EVENT_BYTES = 1 * 1024 * 1024;
export const HISTORY_MAX_PAGE_BYTES = 8 * 1024 * 1024;

export type HistoryAnchorMode = "latest" | "before" | "after" | "around";

export type RawTranscriptEvent = {
  type: string;
  sequence?: number;
  message?: { id: string };
  artifact?: { id: string; messageId: string };
  run?: { id: string; triggerMessageId: string };
  toolCall?: { id: string; runId: string };
};

export interface TranscriptHistoryEntry {
  sequence: number;
  kind: "message" | "artifact" | "run" | "tool";
  id: string;
  parentId: string;
  lineStart: number;
  lineEnd: number;
  lineBytes: number;
}

export interface TranscriptFileIdentity {
  device: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface TranscriptHistoryIndex {
  threadId: string;
  messages: TranscriptHistoryEntry[];
  artifacts: TranscriptHistoryEntry[];
  artifactByMessageId: Map<string, TranscriptHistoryEntry[]>;
  messageById: Map<string, TranscriptHistoryEntry>;
  runLatestByRunId: Map<string, TranscriptHistoryEntry>;
  runByTriggerMessageId: Map<string, TranscriptHistoryEntry[]>;
  toolById: Map<string, TranscriptHistoryEntry>;
  toolCallByRunId: Map<string, TranscriptHistoryEntry[]>;
  identity: TranscriptFileIdentity | null;
  missing: boolean;
  unreliable: boolean;
  malformedLines: number;
  oversizedLines: number;
  invalidUtf8Lines: number;
  tornTailLines: number;
  unknownEventLines: number;
}

export function emptyTranscriptHistoryIndex(threadId: string): TranscriptHistoryIndex {
  return {
    threadId,
    messages: [],
    artifacts: [],
    artifactByMessageId: new Map(),
    messageById: new Map(),
    runLatestByRunId: new Map(),
    runByTriggerMessageId: new Map(),
    toolById: new Map(),
    toolCallByRunId: new Map(),
    identity: null,
    missing: false,
    unreliable: false,
    malformedLines: 0,
    oversizedLines: 0,
    invalidUtf8Lines: 0,
    tornTailLines: 0,
    unknownEventLines: 0,
  };
}

export function transcriptHistoryEntry(
  sequence: number,
  event: RawTranscriptEvent,
  lineStart: number,
  lineEnd: number,
): TranscriptHistoryEntry | undefined {
  const lineBytes = lineEnd - lineStart;
  if (event.type === "message.created" && event.message) {
    return {
      sequence,
      kind: "message",
      id: event.message.id,
      parentId: event.message.id,
      lineStart,
      lineEnd,
      lineBytes,
    };
  }
  if (event.type === "artifact.created" && event.artifact) {
    return {
      sequence,
      kind: "artifact",
      id: event.artifact.id,
      parentId: event.artifact.messageId,
      lineStart,
      lineEnd,
      lineBytes,
    };
  }
  if (event.type === "run.updated" && event.run) {
    return {
      sequence,
      kind: "run",
      id: event.run.id,
      parentId: event.run.triggerMessageId,
      lineStart,
      lineEnd,
      lineBytes,
    };
  }
  if (event.type === "tool.updated" && event.toolCall) {
    return {
      sequence,
      kind: "tool",
      id: event.toolCall.id,
      parentId: event.toolCall.runId,
      lineStart,
      lineEnd,
      lineBytes,
    };
  }
  return undefined;
}

export function addTranscriptHistoryEntry(
  index: TranscriptHistoryIndex,
  entry: TranscriptHistoryEntry,
): void {
  if (entry.kind === "message") {
    index.messages.push(entry);
    index.messageById.set(entry.id, entry);
    return;
  }
  if (entry.kind === "artifact") {
    index.artifacts.push(entry);
    const byParent = index.artifactByMessageId.get(entry.parentId);
    if (byParent) byParent.push(entry);
    else index.artifactByMessageId.set(entry.parentId, [entry]);
    return;
  }
  if (entry.kind === "run") {
    const previous = index.runLatestByRunId.get(entry.id);
    if (previous) {
      if (
        entry.sequence < previous.sequence ||
        (entry.sequence === previous.sequence && entry.lineStart < previous.lineStart)
      ) {
        return;
      }
      const previousRuns = index.runByTriggerMessageId.get(previous.parentId) ?? [];
      const previousIndex = previousRuns.indexOf(previous);
      if (previousIndex >= 0) previousRuns.splice(previousIndex, 1);
      if (previousRuns.length === 0) index.runByTriggerMessageId.delete(previous.parentId);
    }
    index.runLatestByRunId.set(entry.id, entry);
    const runs = index.runByTriggerMessageId.get(entry.parentId) ?? [];
    runs.push(entry);
    index.runByTriggerMessageId.set(entry.parentId, runs);
    return;
  }
  const previousTool = index.toolById.get(entry.id);
  if (previousTool) {
    if (
      entry.sequence < previousTool.sequence ||
      (entry.sequence === previousTool.sequence && entry.lineStart < previousTool.lineStart)
    ) {
      return;
    }
    const previousTools = index.toolCallByRunId.get(previousTool.parentId) ?? [];
    const previousIndex = previousTools.indexOf(previousTool);
    if (previousIndex >= 0) previousTools.splice(previousIndex, 1);
    if (previousTools.length === 0) index.toolCallByRunId.delete(previousTool.parentId);
  }
  index.toolById.set(entry.id, entry);
  const tools = index.toolCallByRunId.get(entry.parentId) ?? [];
  tools.push(entry);
  index.toolCallByRunId.set(entry.parentId, tools);
}

export interface TranscriptHistoryFileScanOutcome {
  status: "ok" | "missing" | "unreadable";
  lineCount: number;
  bytesRead: number;
  malformedLines: number;
  oversizedLines: number;
  invalidUtf8Lines: number;
  tornTailLines: number;
  unknownEventLines: number;
}

export type TranscriptHistoryLineResult =
  | { status: "event"; raw: RawTranscriptEvent }
  | { status: "unknown" }
  | { status: "malformed" };

export interface TranscriptHistoryScanCallbacks {
  onLine: (line: string, lineStart: number, lineEnd: number) => TranscriptHistoryLineResult;
  onLineStatus?: (status: "malformed" | "oversized" | "invalid_utf8" | "unknown") => void;
  maxLineBytes?: number;
}

export async function scanTranscriptHistoryFile(
  file: string,
  callbacks: TranscriptHistoryScanCallbacks,
): Promise<TranscriptHistoryFileScanOutcome> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        status: "missing",
        lineCount: 0,
        bytesRead: 0,
        malformedLines: 0,
        oversizedLines: 0,
        invalidUtf8Lines: 0,
        tornTailLines: 0,
        unknownEventLines: 0,
      };
    }
    return {
      status: "unreadable",
      lineCount: 0,
      bytesRead: 0,
      malformedLines: 0,
      oversizedLines: 0,
      invalidUtf8Lines: 0,
      tornTailLines: 0,
      unknownEventLines: 0,
    };
  }
  const outcome: TranscriptHistoryFileScanOutcome = {
    status: "ok",
    lineCount: 0,
    bytesRead: bytes.byteLength,
    malformedLines: 0,
    oversizedLines: 0,
    invalidUtf8Lines: 0,
    tornTailLines: 0,
    unknownEventLines: 0,
  };
  const maxLineBytes = callbacks.maxLineBytes ?? HISTORY_MAX_EVENT_BYTES;
  let lineStart = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    const atEnd = index === bytes.byteLength;
    const isNewline = !atEnd && bytes[index] === 0x0a;
    if (!atEnd && !isNewline) continue;
    const lineEnd = atEnd ? index : index + 1;
    if (lineEnd > lineStart) {
      outcome.lineCount += 1;
      const lineBytes = lineEnd - lineStart;
      if (lineBytes > maxLineBytes) {
        outcome.oversizedLines += 1;
        callbacks.onLineStatus?.("oversized");
      } else {
        const slice = bytes.subarray(lineStart, isNewline ? lineEnd - 1 : lineEnd);
        const text = decodeUtf8(slice);
        if (text === null) {
          outcome.invalidUtf8Lines += 1;
          callbacks.onLineStatus?.("invalid_utf8");
        } else if (text.trim().length === 0) {
          // Match readEvents: blank/whitespace lines are ignored, not corruption.
        } else {
          try {
            const parsedResult = callbacks.onLine(text, lineStart, lineEnd);
            if (parsedResult.status === "unknown") outcome.unknownEventLines += 1;
            else if (parsedResult.status === "malformed") {
              outcome.malformedLines += 1;
              callbacks.onLineStatus?.("malformed");
            }
          } catch {
            outcome.malformedLines += 1;
            callbacks.onLineStatus?.("malformed");
          }
        }
      }
    }
    lineStart = lineEnd;
  }
  if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] !== 0x0a) {
    outcome.tornTailLines += 1;
  }
  return outcome;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface HistoryPageSelection {
  messageEntries: TranscriptHistoryEntry[];
  artifactEntries: TranscriptHistoryEntry[];
  runEntries: TranscriptHistoryEntry[];
  toolEntries: TranscriptHistoryEntry[];
  firstMessageIndex: number;
  lastMessageIndex: number;
  beforeCursor: string | null;
  afterCursor: string | null;
  targetMessageId?: string;
  targetFound?: boolean;
}

export function planHistoryPage(
  index: TranscriptHistoryIndex,
  mode: HistoryAnchorMode,
  anchorMessageId: string | undefined,
  limit: number,
): { plan: HistoryPageSelection; ok: boolean; reason?: string } {
  const total = index.messages.length;
  const emptyPlan: HistoryPageSelection = {
    messageEntries: [],
    artifactEntries: [],
    runEntries: [],
    toolEntries: [],
    firstMessageIndex: 0,
    lastMessageIndex: 0,
    beforeCursor: null,
    afterCursor: null,
  };
  if (mode === "latest") {
    return {
      ok: true,
      plan: completePlan(index, Math.max(0, total - limit), total, total, emptyPlan),
    };
  }
  if (!anchorMessageId) return { ok: false, reason: "Unknown message anchor.", plan: emptyPlan };
  const anchorIndex = index.messages.findIndex((entry) => entry.id === anchorMessageId);
  if (anchorIndex < 0) {
    if (mode === "around") {
      const plan = completePlan(index, Math.max(0, total - limit), total, total, emptyPlan);
      plan.targetMessageId = anchorMessageId;
      plan.targetFound = false;
      return { ok: true, plan };
    }
    return { ok: false, reason: "Unknown message anchor in this thread.", plan: emptyPlan };
  }
  if (mode === "before") {
    return {
      ok: true,
      plan: completePlan(index, Math.max(0, anchorIndex - limit), anchorIndex, total, emptyPlan),
    };
  }
  if (mode === "after") {
    return {
      ok: true,
      plan: completePlan(index, anchorIndex + 1, anchorIndex + 1 + limit, total, emptyPlan),
    };
  }
  const half = Math.floor((limit - 1) / 2);
  const start = Math.min(Math.max(0, total - limit), Math.max(0, anchorIndex - half));
  const plan = completePlan(index, start, start + limit, total, emptyPlan);
  plan.targetMessageId = anchorMessageId;
  plan.targetFound = true;
  return { ok: true, plan };
}

function completePlan(
  index: TranscriptHistoryIndex,
  rawStart: number,
  rawEnd: number,
  total: number,
  emptyPlan: HistoryPageSelection,
): HistoryPageSelection {
  const start = Math.max(0, Math.min(total, rawStart));
  const end = Math.max(start, Math.min(total, rawEnd));
  const messageEntries = index.messages.slice(start, end);
  if (messageEntries.length === 0) return emptyPlan;
  const messageIds = new Set(messageEntries.map((entry) => entry.id));
  const artifactEntries: TranscriptHistoryEntry[] = [];
  for (const id of messageIds) {
    const artifacts = index.artifactByMessageId.get(id);
    if (artifacts) artifactEntries.push(...artifacts);
  }
  const triggerIds = new Set(messageEntries.map((entry) => entry.id));
  const runEntries: TranscriptHistoryEntry[] = [];
  for (const id of triggerIds) {
    const runs = index.runByTriggerMessageId.get(id);
    if (runs) runEntries.push(...runs);
  }
  const runIds = new Set(runEntries.map((entry) => entry.id));
  const toolEntries: TranscriptHistoryEntry[] = [];
  for (const id of runIds) {
    const tools = index.toolCallByRunId.get(id);
    if (tools) toolEntries.push(...tools);
  }
  return {
    messageEntries,
    artifactEntries,
    runEntries,
    toolEntries,
    firstMessageIndex: start + 1,
    lastMessageIndex: end,
    beforeCursor: start > 0 ? (messageEntries[0]?.id ?? null) : null,
    afterCursor: end < total ? (messageEntries[messageEntries.length - 1]?.id ?? null) : null,
  };
}

export type TranscriptPageReadOutcome =
  | { status: "ok"; lines: string[] }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "mismatch" }
  | { status: "invalid_utf8" };

export async function readTranscriptPageLines(
  file: string,
  expected: TranscriptFileIdentity,
  entries: readonly TranscriptHistoryEntry[],
): Promise<TranscriptPageReadOutcome> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await open(file, "r");
    const initial = await handle.stat({ bigint: true });
    if (!identitiesMatch(initial, expected)) return { status: "mismatch" };
    const lines: string[] = [];
    for (const entry of entries) {
      const remaining = entry.lineEnd - entry.lineStart;
      if (remaining > HISTORY_MAX_EVENT_BYTES || entry.lineEnd > expected.size) {
        return { status: "mismatch" };
      }
      const buffer = Buffer.allocUnsafe(remaining);
      let readOffset = 0;
      while (readOffset < remaining) {
        const { bytesRead } = await handle.read(
          buffer,
          readOffset,
          remaining - readOffset,
          entry.lineStart + readOffset,
        );
        if (bytesRead <= 0) return { status: "mismatch" };
        readOffset += bytesRead;
      }
      const line = decodeUtf8(buffer.subarray(0, remaining));
      if (line === null) return { status: "invalid_utf8" };
      lines.push(line);
    }
    const final = await handle.stat({ bigint: true });
    if (!identitiesMatch(final, expected)) return { status: "mismatch" };
    return { status: "ok", lines };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    return { status: "unreadable" };
  } finally {
    await handle?.close();
  }
}

function identitiesMatch(
  stat: {
    dev: bigint;
    ino: bigint;
    size: bigint | number;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  expected: TranscriptFileIdentity,
): boolean {
  return (
    stat.dev === expected.device &&
    stat.ino === expected.ino &&
    Number(stat.size) === expected.size &&
    stat.mtimeNs === expected.mtimeNs &&
    stat.ctimeNs === expected.ctimeNs
  );
}

export function transcriptFileIdentityOf(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint | number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): TranscriptFileIdentity {
  return {
    device: stat.dev,
    ino: stat.ino,
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === code;
}
