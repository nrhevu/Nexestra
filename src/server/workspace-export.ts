import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_MAX_ENTRIES,
  WORKSPACE_EXPORT_MAX_SOURCE_BYTES,
  WORKSPACE_EXPORT_TIMEOUT_MS,
} from "../shared/contracts.js";
import {
  type FileStore,
  type PreparedWorkspaceExport,
  type PreparedWorkspaceExportFile,
  readWorkspaceExportLines,
  StoreError,
} from "./store.js";
import {
  type BuiltWorkspaceExportArchive,
  buildWorkspaceExportArchive,
  WorkspaceExportArchiveError,
  type WorkspaceExportSourceEntry,
} from "./workspace-export-archive.js";

export const WORKSPACE_EXPORT_DOWNLOAD_TIMEOUT_MS = 60_000;

const EXPORT_READ_CHUNK_BYTES = 64 * 1024;

export interface CreateWorkspaceExportInput {
  store: FileStore;
  workspaceId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CreateWorkspaceExportResponseInput extends CreateWorkspaceExportInput {
  stallTimeoutMs?: number;
}

export async function createWorkspaceExport(
  input: CreateWorkspaceExportInput,
): Promise<BuiltWorkspaceExportArchive> {
  const timeoutMs = input.timeoutMs ?? WORKSPACE_EXPORT_TIMEOUT_MS;
  const startedAt = performance.now();
  const prepared = await input.store.prepareWorkspaceExport(input.workspaceId, {
    signal: input.signal,
    timeoutMs,
  });
  try {
    const elapsed = performance.now() - startedAt;
    const remaining = Math.max(1, timeoutMs - Math.floor(elapsed));
    const archive = await buildWorkspaceExportArchive({
      workspace: prepared.workspace,
      createdAt: prepared.createdAt,
      entries: workspaceExportEntries(prepared, input.store, () =>
        assertWorkspaceExportActive(input.signal, startedAt, timeoutMs),
      ),
      signal: input.signal,
      limits: {
        maxSourceBytes: WORKSPACE_EXPORT_MAX_SOURCE_BYTES,
        maxArchiveBytes: WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
        maxEntries: WORKSPACE_EXPORT_MAX_ENTRIES,
        timeoutMs: remaining,
      },
    });
    const originalDispose = archive.dispose;
    return {
      path: archive.path,
      size: archive.size,
      manifest: archive.manifest,
      dispose: async () => {
        try {
          await originalDispose();
        } finally {
          await prepared.release();
        }
      },
    };
  } catch (error) {
    await prepared.release().catch(() => undefined);
    throw toStoreError(error);
  }
}

export async function createWorkspaceExportResponse(
  input: CreateWorkspaceExportResponseInput,
): Promise<Response> {
  const archive = await createWorkspaceExport(input);
  const stallTimeoutMs = input.stallTimeoutMs ?? WORKSPACE_EXPORT_DOWNLOAD_TIMEOUT_MS;
  const filename = workspaceExportFilename(
    archive.manifest.workspace.id,
    archive.manifest.createdAt,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(archive.path, "r");
    const body = exportDownloadStream(handle, archive, stallTimeoutMs);
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(archive.size),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await archive.dispose().catch(() => undefined);
    throw toStoreError(error);
  }
}

export async function* workspaceExportEntries(
  prepared: PreparedWorkspaceExport,
  _store: FileStore,
  assertActive: () => void,
): AsyncGenerator<WorkspaceExportSourceEntry, void> {
  const redact = prepared.redactText;
  const scanCredential = prepared.createCredentialScanner();
  yield {
    path: "state.json",
    kind: "metadata",
    chunks: stateEntryChunks(prepared.state, redact, assertActive),
  };
  for (const file of prepared.files) {
    assertActive();
    if (redact(file.archivePath) !== file.archivePath) {
      throw exportInvalid("Workspace export entry path contains a credential.");
    }
    const chunks =
      file.kind === "transcript" && file.identity === null
        ? emptyEntryChunks()
        : file.kind === "transcript"
          ? transcriptEntryChunks(file, redact, assertActive)
          : binaryEntryChunks(file, scanCredential, assertActive);
    yield { path: file.archivePath, kind: file.kind, chunks };
  }
  for (const file of prepared.files) {
    assertActive();
    await prepared.validateFile(file);
  }
}

async function* stateEntryChunks(
  state: PreparedWorkspaceExport["state"],
  redact: (value: string) => string,
  assertActive: () => void,
): AsyncGenerator<Uint8Array, void> {
  assertActive();
  const redacted = redactExportValue(state, redact);
  const text = `${JSON.stringify(redacted, null, 2)}\n`;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  for (let offset = 0; offset < bytes.byteLength; offset += EXPORT_READ_CHUNK_BYTES) {
    yield bytes.subarray(offset, offset + EXPORT_READ_CHUNK_BYTES);
  }
}

async function* transcriptEntryChunks(
  file: PreparedWorkspaceExportFile,
  redact: (value: string) => string,
  assertActive: () => void,
): AsyncGenerator<Uint8Array, void> {
  const identity = file.identity;
  if (!identity) return;
  const encoder = new TextEncoder();
  for await (const { text, blank } of readWorkspaceExportLines(file.sourcePath, identity, {
    assertActive,
  })) {
    if (blank) {
      yield encoder.encode("\n");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw exportInvalid("Workspace export transcript contains malformed JSON.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw exportInvalid("Workspace export transcript contains a malformed JSON event.");
    }
    const redacted = redactExportValue(parsed, redact);
    yield encoder.encode(`${JSON.stringify(redacted)}\n`);
  }
}

async function* binaryEntryChunks(
  file: PreparedWorkspaceExportFile,
  scanCredential: (chunk: Uint8Array) => boolean,
  assertActive: () => void,
): AsyncGenerator<Uint8Array, void> {
  const identity = file.identity;
  if (!identity) return;
  const handle = await open(file.sourcePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(EXPORT_READ_CHUNK_BYTES);
    const hash = createHash("sha256");
    let totalBytes = 0;
    let position = 0n;
    const expectedSize = BigInt(identity.size);
    while (position < expectedSize) {
      assertActive();
      const { bytesRead } = await handle.read(buffer, 0, EXPORT_READ_CHUNK_BYTES, position);
      if (bytesRead <= 0) {
        throw exportConflict("Workspace export source changed during preparation.");
      }
      const chunk = buffer.subarray(0, bytesRead);
      totalBytes += bytesRead;
      position += BigInt(bytesRead);
      if (scanCredential(chunk)) {
        throw exportInvalid(
          "Workspace export cannot include binary content that contains a known credential.",
        );
      }
      hash.update(chunk);
      yield new Uint8Array(chunk);
    }
    if (totalBytes !== identity.size) {
      throw exportConflict("Workspace export source changed during preparation.");
    }
    if (file.sha256 !== undefined && hash.digest("hex") !== file.sha256) {
      throw exportInvalid("Workspace export document content is corrupted.");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function emptyEntryChunks(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<Uint8Array>> {
        return { done: true, value: undefined };
      },
    }),
  };
}

function redactExportValue(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactExportValue(item, redact));
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = Object.create(null);
  for (const originalKey of Object.keys(source)) {
    const key = redact(originalKey);
    if (Object.hasOwn(result, key)) {
      throw exportInvalid("Workspace export metadata contains colliding keys after redaction.");
    }
    Object.defineProperty(result, key, {
      value: redactExportValue(source[originalKey], redact),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function exportDownloadStream(
  handle: Awaited<ReturnType<typeof open>>,
  archive: BuiltWorkspaceExportArchive,
  stallTimeoutMs: number,
  absoluteTimeoutMs: number = Math.max(stallTimeoutMs, 60_000),
): ReadableStream<Uint8Array> {
  const reader = handle.readableWebStream().getReader();
  let finished = false;
  let stallTimer = setTimeout(() => void stall(), stallTimeoutMs);
  const lifetimeTimer = setTimeout(() => void stall(), absoluteTimeoutMs);
  const cleanup = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    clearTimeout(stallTimer);
    clearTimeout(lifetimeTimer);
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await archive.dispose().catch(() => undefined);
  };
  const stall = (): void => {
    void cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => void stall(), stallTimeoutMs);
      try {
        const { done, value } = await reader.read();
        clearTimeout(stallTimer);
        if (done) {
          await cleanup();
          controller.close();
        } else {
          controller.enqueue(value);
          stallTimer = setTimeout(() => void stall(), stallTimeoutMs);
        }
      } catch (error) {
        clearTimeout(stallTimer);
        await cleanup();
        throw error;
      }
    },
    async cancel() {
      clearTimeout(stallTimer);
      await cleanup();
    },
  });
}

function assertWorkspaceExportActive(
  signal: AbortSignal | undefined,
  startedAt: number,
  timeoutMs: number,
): void {
  if (signal?.aborted) {
    throw exportConflict("Workspace export was cancelled.");
  }
  if (performance.now() - startedAt >= timeoutMs) {
    throw exportConflict("Workspace export timed out.");
  }
}

function exportInvalid(message: string): WorkspaceExportArchiveError {
  return new WorkspaceExportArchiveError("invalid", message);
}

function exportConflict(message: string): WorkspaceExportArchiveError {
  return new WorkspaceExportArchiveError("conflict", message);
}

function toStoreError(error: unknown): StoreError {
  if (error instanceof WorkspaceExportArchiveError) {
    return new StoreError(error.code, error.message);
  }
  if (error instanceof StoreError) return error;
  return new StoreError("invalid", "Workspace export failed.");
}

function workspaceExportFilename(workspaceId: string, createdAt: string): string {
  const safeId = workspaceId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `nexestra-workspace-${safeId}-${createdAt.slice(0, 10)}.zip`;
}
