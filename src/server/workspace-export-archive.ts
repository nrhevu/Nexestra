import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, Zip, ZipPassThrough } from "fflate";
import type {
  Workspace,
  WorkspaceExportEntry,
  WorkspaceExportManifest,
} from "../shared/contracts.js";
import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_MAX_ENTRIES,
  WORKSPACE_EXPORT_MAX_SOURCE_BYTES,
  WORKSPACE_EXPORT_TIMEOUT_MS,
  WorkspaceExportManifestSchema,
} from "../shared/contracts.js";

export interface WorkspaceExportSourceEntry {
  path: string;
  kind: Exclude<WorkspaceExportEntry["kind"], "notice">;
  chunks: AsyncIterable<Uint8Array>;
}

export interface BuiltWorkspaceExportArchive {
  path: string;
  size: number;
  manifest: WorkspaceExportManifest;
  dispose(): Promise<void>;
}

export class WorkspaceExportArchiveError extends Error {
  readonly code: "invalid" | "conflict";

  constructor(code: "invalid" | "conflict", message: string) {
    super(message);
    this.name = "WorkspaceExportArchiveError";
    this.code = code;
  }
}

const ARCHIVE_FILE_NAME = "workspace-export.zip";
const TEMP_DIR_PREFIX = "nexestra-workspace-export-";
const NOTICE_PATH = "NOTICE.txt";
const MANIFEST_PATH = "manifest.json";
const MAX_PATH_BYTES = 1_024;
const LOCAL_HEADER_BYTES = 30;
const DATA_DESCRIPTOR_BYTES = 16;
const CENTRAL_DIRECTORY_BYTES = 46;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const PER_ENTRY_OVERHEAD = LOCAL_HEADER_BYTES + DATA_DESCRIPTOR_BYTES + CENTRAL_DIRECTORY_BYTES;
const CLEANUP_GRACE_MS = 100;
const SOURCE_KINDS = new Set(["metadata", "transcript", "upload", "document", "whiteboard"]);

const NOTICE_TEXT = `Nexestra workspace export

This archive is a point-in-time snapshot of the selected workspace.
Known credential values are redacted from metadata and transcripts.
Whiteboard notes are included with known credentials redacted.
Original upload and document binaries are preserved byte-for-byte; exports that would include a literal known credential sequence in a binary are rejected rather than altered.
Excluded: credentials, harness-auth, repository-files, browser-state, unreferenced-files.
Archives can be imported as a new archived workspace; merge and overwrite restore are not supported.
`;

const INVALID_ENTRY = "Workspace export source entry is invalid.";
const INVALID_PATH = "Workspace export entry path is invalid.";
const DUPLICATE_PATH = "Workspace export entry path is duplicated.";
const LIMIT_SOURCE = "Workspace export source size limit exceeded.";
const LIMIT_ARCHIVE = "Workspace export archive size limit exceeded.";
const LIMIT_ENTRIES = "Workspace export entry limit exceeded.";
const CANCELLED = "Workspace export was cancelled.";
const TIMEOUT = "Workspace export timed out.";
const IO_ERROR = "Workspace export archive could not be built.";
const WRITE_ERROR = "Workspace export archive write failed.";
const MANIFEST_ERROR = "Workspace export manifest is invalid.";
const ENCODE_ERROR = "Workspace export archive encoding failed.";
const CLEANUP_ERROR = "Workspace export archive cleanup failed.";

function invalid(message: string): WorkspaceExportArchiveError {
  return new WorkspaceExportArchiveError("invalid", message);
}

function conflict(message: string): WorkspaceExportArchiveError {
  return new WorkspaceExportArchiveError("conflict", message);
}

function toPublicError(error: unknown): WorkspaceExportArchiveError {
  if (error instanceof WorkspaceExportArchiveError) return error;
  if (error instanceof Error && error.name === "AbortError") return conflict(CANCELLED);
  return invalid(IO_ERROR);
}

function entryOverheadBytes(path: string): number {
  return PER_ENTRY_OVERHEAD + 2 * Buffer.byteLength(path, "utf8");
}

function isValidArchivePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.length > MAX_PATH_BYTES || Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES)
    return false;
  if (path === NOTICE_PATH || path === MANIFEST_PATH) return false;
  if (path.includes(":") || path.includes("\\")) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code === 0 || code < 0x20 || code === 0x7f) return false;
  }
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

function isSourceKind(kind: unknown): kind is WorkspaceExportSourceEntry["kind"] {
  return typeof kind === "string" && SOURCE_KINDS.has(kind as WorkspaceExportSourceEntry["kind"]);
}

export async function buildWorkspaceExportArchive(input: {
  workspace: Pick<Workspace, "id" | "name">;
  createdAt: string;
  entries: AsyncIterable<WorkspaceExportSourceEntry>;
  signal?: AbortSignal;
  limits?: {
    maxSourceBytes?: number;
    maxArchiveBytes?: number;
    maxEntries?: number;
    timeoutMs?: number;
  };
}): Promise<BuiltWorkspaceExportArchive> {
  const maxSourceBytes = input.limits?.maxSourceBytes ?? WORKSPACE_EXPORT_MAX_SOURCE_BYTES;
  const maxArchiveBytes = input.limits?.maxArchiveBytes ?? WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES;
  const maxEntries = input.limits?.maxEntries ?? WORKSPACE_EXPORT_MAX_ENTRIES;
  const timeoutMs = input.limits?.timeoutMs ?? WORKSPACE_EXPORT_TIMEOUT_MS;

  if (
    !Number.isSafeInteger(maxSourceBytes) ||
    maxSourceBytes < 0 ||
    !Number.isSafeInteger(maxArchiveBytes) ||
    maxArchiveBytes < 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 2 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw invalid("Workspace export limits are invalid.");
  }

  let tempDir: string | undefined;
  let disposePromise: Promise<void> | null = null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let closePromise: Promise<void> | undefined;
  let deadlineHit = false;
  let cancelled = false;

  function dispose(): Promise<void> {
    const ownedDir = tempDir;
    if (!ownedDir) return Promise.resolve();
    if (!disposePromise) {
      disposePromise = Promise.resolve()
        .then(() => rm(ownedDir, { recursive: true, force: true }))
        .catch(() => {
          disposePromise = null;
          throw invalid(CLEANUP_ERROR);
        });
    }
    return disposePromise;
  }

  function closeHandle(): Promise<void> {
    const ownedHandle = handle;
    if (!ownedHandle) return Promise.resolve();
    closePromise ??= Promise.resolve().then(() => ownedHandle.close());
    return closePromise;
  }

  function startCleanup(): Promise<void> {
    const closing = closeHandle().catch(() => {});
    // Removal must start even when close never settles. Retry after close if
    // removal failed while the file was still open; observe every late result.
    const removing = dispose().catch(() => {});
    void Promise.all([closing, removing])
      .then(() => dispose())
      .catch(() => {});
    return removing;
  }

  async function cleanupWithinGrace(): Promise<void> {
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        startCleanup(),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(resolve, CLEANUP_GRACE_MS);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }

  let rejectDeadline!: (error: WorkspaceExportArchiveError) => void;
  const deadlinePromise = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const deadlineTimer = setTimeout(() => {
    deadlineHit = true;
    cancelled = true;
    rejectDeadline(conflict(TIMEOUT));
  }, timeoutMs);

  const onAbort = () => {
    cancelled = true;
    rejectDeadline(conflict(CANCELLED));
  };
  if (input.signal) {
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  }

  function assertActive(): void {
    if (deadlineHit) throw conflict(TIMEOUT);
    if (cancelled || input.signal?.aborted) throw conflict(CANCELLED);
  }

  try {
    const workPromise = (async () => {
      let prepared = false;
      try {
        assertActive();
        tempDir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
        assertActive();
        const archivePath = join(tempDir, ARCHIVE_FILE_NAME);
        handle = await open(archivePath, "wx", 0o600);
        assertActive();

        const budget = {
          projectedBytes: END_OF_CENTRAL_DIRECTORY_BYTES,
          archiveBytesWritten: 0,
          writeChain: Promise.resolve(),
          writeError: undefined as WorkspaceExportArchiveError | undefined,
        };

        function ensureEntryCapacity(path: string): void {
          const overhead = entryOverheadBytes(path);
          if (budget.projectedBytes + overhead > maxArchiveBytes) throw invalid(LIMIT_ARCHIVE);
          budget.projectedBytes += overhead;
        }

        function ensureChunkCapacity(length: number): void {
          if (budget.projectedBytes + length > maxArchiveBytes) throw invalid(LIMIT_ARCHIVE);
          budget.projectedBytes += length;
        }

        async function writeChunk(chunk: Uint8Array): Promise<void> {
          assertActive();
          if (!handle) throw invalid(WRITE_ERROR);
          if (budget.archiveBytesWritten + chunk.byteLength > maxArchiveBytes)
            throw invalid(LIMIT_ARCHIVE);
          let offset = 0;
          while (offset < chunk.byteLength) {
            assertActive();
            const result = await handle.write(chunk.subarray(offset));
            if (result.bytesWritten === 0) throw invalid(WRITE_ERROR);
            offset += result.bytesWritten;
            budget.archiveBytesWritten += result.bytesWritten;
          }
        }

        const zip = new Zip((error, chunk, _final) => {
          if (budget.writeError) return;
          if (error) {
            budget.writeError = invalid(ENCODE_ERROR);
            return;
          }
          budget.writeChain = budget.writeChain
            .then(() => writeChunk(chunk))
            .catch((cause: unknown) => {
              budget.writeError = toPublicError(cause);
              throw budget.writeError;
            });
        });

        async function flushWrites(): Promise<void> {
          await budget.writeChain;
          if (budget.writeError) throw budget.writeError;
        }

        const buildPromise = (async () => {
          const manifestEntries: WorkspaceExportEntry[] = [];
          const seenPaths = new Set<string>();
          let sourceBytesTotal = 0;

          const noticeBytes = strToU8(NOTICE_TEXT);
          ensureEntryCapacity(NOTICE_PATH);
          ensureChunkCapacity(noticeBytes.byteLength);
          const noticeStream = new ZipPassThrough(NOTICE_PATH);
          zip.add(noticeStream);
          await flushWrites();
          noticeStream.push(noticeBytes, true);
          await flushWrites();
          manifestEntries.push({
            path: NOTICE_PATH,
            kind: "notice",
            bytes: noticeBytes.byteLength,
            sha256: hashBytes(noticeBytes),
          });

          for await (const sourceEntry of input.entries) {
            assertActive();
            if (
              !sourceEntry ||
              typeof sourceEntry.path !== "string" ||
              !isSourceKind(sourceEntry.kind)
            ) {
              throw invalid(INVALID_ENTRY);
            }
            if (manifestEntries.length + 1 >= maxEntries) throw invalid(LIMIT_ENTRIES);
            if (seenPaths.has(sourceEntry.path)) throw invalid(DUPLICATE_PATH);
            if (!isValidArchivePath(sourceEntry.path)) throw invalid(INVALID_PATH);
            seenPaths.add(sourceEntry.path);

            ensureEntryCapacity(sourceEntry.path);
            const entryStream = new ZipPassThrough(sourceEntry.path);
            zip.add(entryStream);
            await flushWrites();

            const hash = createHash("sha256");
            let bytes = 0;
            for await (const chunk of sourceEntry.chunks) {
              assertActive();
              if (!(chunk instanceof Uint8Array)) throw invalid(INVALID_ENTRY);
              if (
                chunk.byteLength > maxSourceBytes ||
                chunk.byteLength > maxSourceBytes - sourceBytesTotal
              ) {
                throw invalid(LIMIT_SOURCE);
              }
              ensureChunkCapacity(chunk.byteLength);
              hash.update(chunk);
              bytes += chunk.byteLength;
              sourceBytesTotal += chunk.byteLength;
              entryStream.push(chunk, false);
              await flushWrites();
            }

            entryStream.push(new Uint8Array(), true);
            await flushWrites();

            manifestEntries.push({
              path: sourceEntry.path,
              kind: sourceEntry.kind,
              bytes,
              sha256: hash.digest("hex"),
            });
          }

          const manifest = {
            format: "nexestra.workspace-export",
            version: 1,
            createdAt: input.createdAt,
            workspace: input.workspace,
            stateVersion: 7,
            redaction: "known-credentials",
            importSupported: true,
            excluded: [
              "credentials",
              "harness-auth",
              "repository-files",
              "browser-state",
              "unreferenced-files",
            ],
            entries: manifestEntries,
          };
          const parsedManifest = WorkspaceExportManifestSchema.safeParse(manifest);
          if (!parsedManifest.success) throw invalid(MANIFEST_ERROR);

          const manifestBytes = strToU8(JSON.stringify(parsedManifest.data, null, 2));
          ensureEntryCapacity(MANIFEST_PATH);
          ensureChunkCapacity(manifestBytes.byteLength);
          const manifestStream = new ZipPassThrough(MANIFEST_PATH);
          zip.add(manifestStream);
          await flushWrites();
          manifestStream.push(manifestBytes, true);
          await flushWrites();

          zip.end();
          await flushWrites();

          return parsedManifest.data;
        })();

        const manifest = await Promise.race([buildPromise, deadlinePromise]);
        assertActive();
        await handle.sync();
        assertActive();
        const stats = await handle.stat();
        assertActive();
        if (stats.size > maxArchiveBytes) throw invalid(LIMIT_ARCHIVE);
        await closeHandle();
        assertActive();
        prepared = true;
        return { path: archivePath, size: stats.size, manifest, dispose };
      } finally {
        if (!prepared) {
          cancelled = true;
          // This finally also owns resources that resolve after the outer race.
          void startCleanup();
        }
      }
    })();

    return await Promise.race([workPromise, deadlinePromise]);
  } catch (error) {
    cancelled = true;
    await cleanupWithinGrace();
    throw toPublicError(error);
  } finally {
    clearTimeout(deadlineTimer);
    if (input.signal) input.signal.removeEventListener("abort", onAbort);
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
