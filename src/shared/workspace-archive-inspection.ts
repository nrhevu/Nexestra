import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_MAX_ENTRIES,
  WORKSPACE_EXPORT_MAX_SOURCE_BYTES,
  type WorkspaceExportEntry,
  WorkspaceExportManifestSchema,
} from "./contracts.js";
import {
  WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS,
  type WorkspaceArchiveInspectionFailure,
  type WorkspaceArchiveInspectionProgress,
  type WorkspaceArchiveInspectionReport,
  WorkspaceArchiveInspectionReportSchema,
} from "./workspace-archive-inspection-contracts.js";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const END_OF_CENTRAL_DIRECTORY_LENGTH = 22;
const MAX_EOCD_TAIL_BYTES = 65_557;
const LOCAL_HEADER_LENGTH = 30;
const CENTRAL_HEADER_LENGTH = 46;
const MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_NOTICE_BYTES = 64 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 1_024;
const ALLOWED_FLAG_BITS = 0x0808;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const MANIFEST_PATH = "manifest.json";
const NOTICE_PATH = "NOTICE.txt";
const STATE_PATH = "state.json";
const REQUIRED_EXCLUSIONS = [
  "credentials",
  "harness-auth",
  "repository-files",
  "browser-state",
  "unreferenced-files",
] as const;
const MSG_ARCHIVE_LIMIT = "Workspace archive exceeds the supported size limit.";
const MSG_ENTRY_COUNT_LIMIT = "Workspace archive contains too many entries.";
const MSG_CENTRAL_LIMIT = "Workspace archive central directory exceeds the supported size limit.";
const MSG_ENTRY_SIZE_LIMIT = "Workspace archive entry exceeds the supported size limit.";
const MSG_MANIFEST_SIZE_LIMIT = "Workspace archive manifest exceeds the supported size limit.";
const MSG_NOTICE_SIZE_LIMIT = "Workspace archive notice exceeds the supported size limit.";
const MSG_SOURCE_SIZE_LIMIT = "Workspace archive source payload exceeds the supported size limit.";
const MSG_ZIP64 = "Workspace archive uses an unsupported ZIP64 layout.";
const MSG_MULTI_DISK = "Workspace archive uses unsupported spanning or multi-disk layout.";
const MSG_COMPRESSION = "Workspace archive uses unsupported compression.";
const MSG_ENCRYPTION = "Workspace archive uses unsupported encryption.";
const MSG_FLAGS = "Workspace archive uses unsupported flag bits.";
const MSG_EXTRA_FIELDS = "Workspace archive uses unsupported extra fields.";
const MSG_VERSION = "Workspace archive uses an unsupported header version.";
const MSG_STRUCTURE = "Workspace archive structure is invalid.";
const MSG_PATH = "Workspace archive entry path is invalid.";
const MSG_PATH_ENCODING = "Workspace archive entry path is not valid UTF-8.";
const MSG_DUPLICATE = "Workspace archive contains duplicate entry paths.";
const MSG_DESCRIPTOR = "Workspace archive data descriptor is invalid.";
const MSG_INTEGRITY = "Workspace archive payload integrity check failed.";
const MSG_HASH = "Workspace archive payload hash does not match its manifest.";
const MSG_MANIFEST = "Workspace archive manifest is invalid.";
const MSG_MANIFEST_UNSUPPORTED = "Workspace archive manifest uses an unsupported version.";
const MSG_MANIFEST_COVERAGE = "Workspace archive manifest does not match its archive layout.";
const MSG_KIND = "Workspace archive entry kind is inconsistent with its path.";
const MSG_CANCELLED = "Workspace archive inspection was cancelled.";
const MSG_TIMEOUT = "Workspace archive inspection timed out.";
const MSG_WEBCRYPTO = "Workspace archive inspection requires WebCrypto SHA-256 support.";
const MSG_INTERNAL = "Workspace archive inspection failed.";

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class WorkspaceArchiveInspectionError extends Error {
  readonly code: WorkspaceArchiveInspectionFailure["code"];
  readonly path?: string;

  constructor(code: WorkspaceArchiveInspectionFailure["code"], message: string, path?: string) {
    super(message);
    this.name = "WorkspaceArchiveInspectionError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export interface WorkspaceArchiveInspectionOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceArchiveInspectionProgress) => void;
  expectedWorkspace?: {
    id: string;
    name: string;
  };
}

interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): BlobLike;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface ActiveState {
  deadlineFired: boolean;
  signalAborted: boolean;
  deadlineAt: number;
  totalEntries: number;
  totalBytes: number;
}

interface ParsedEocd {
  cdOffset: number;
  cdSize: number;
  totalEntries: number;
  eocdOffset: number;
}

interface ParsedCentralEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  size: number;
  localHeaderOffset: number;
  dataOffset: number;
  end: number;
  descriptor?: { offset: number; length: number };
}

function invalid(message: string, path?: string): WorkspaceArchiveInspectionError {
  return new WorkspaceArchiveInspectionError("invalid", message, path);
}

function unsupported(message: string, path?: string): WorkspaceArchiveInspectionError {
  return new WorkspaceArchiveInspectionError("unsupported", message, path);
}

function limit(message: string, path?: string): WorkspaceArchiveInspectionError {
  return new WorkspaceArchiveInspectionError("limit", message, path);
}

function cancelled(message: string): WorkspaceArchiveInspectionError {
  return new WorkspaceArchiveInspectionError("cancelled", message);
}

function unsupportedWebCrypto(): WorkspaceArchiveInspectionError {
  return unsupported(MSG_WEBCRYPTO);
}

function toInspectionError(error: unknown): WorkspaceArchiveInspectionError {
  if (error instanceof WorkspaceArchiveInspectionError) return error;
  return invalid(MSG_INTERNAL);
}

function u16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) & 0xffff;
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    value = (CRC_TABLE[(value ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function parsedEntryAt(entries: readonly ParsedCentralEntry[], index: number): ParsedCentralEntry {
  const entry = entries[index];
  if (entry === undefined) throw invalid(MSG_STRUCTURE);
  return entry;
}

function isSafeArchivePath(path: string): boolean {
  if (path.length === 0) return false;
  const encodedPath = new TextEncoder().encode(path);
  if (encodedPath.byteLength > MAX_ARCHIVE_PATH_BYTES) return false;
  if (path.includes("\ufeff")) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes(":")) return false;
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

function decodeArchivePath(bytes: Uint8Array, flags: number): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw invalid(MSG_PATH_ENCODING);
  }
  if ((flags & UTF8_FLAG) !== 0) {
    try {
      return UTF8_DECODER.decode(bytes);
    } catch {
      throw invalid(MSG_PATH_ENCODING);
    }
  }
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if ((bytes[index] ?? 0) > 0x7f) throw invalid(MSG_PATH_ENCODING);
  }
  let path = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    path += String.fromCharCode(bytes[index] ?? 0);
  }
  return path;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isConsistentEntryKind(entry: WorkspaceExportEntry, workspaceId: string): boolean {
  const { path, kind } = entry;
  if (path === NOTICE_PATH) return kind === "notice";
  if (path === STATE_PATH) return kind === "metadata";
  if (path.startsWith("threads/")) {
    return kind === "transcript" && /^[^/]+\.jsonl$/.test(path.slice("threads/".length));
  }
  if (path.startsWith("artifacts/")) {
    return kind === "upload" && /^[^/]+\/[^/]+$/.test(path.slice("artifacts/".length));
  }
  if (path.startsWith("workspaces/")) {
    if (kind !== "document") return false;
    const rest = path.slice("workspaces/".length);
    const workspaceMatch = rest.match(/^([^/]+)\/knowledge\/([^/]+)\/(document|revisions\/[^/]+)$/);
    return workspaceMatch !== null && workspaceMatch[1] === workspaceId;
  }
  return false;
}

function readU8Array(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (
    typeof crypto === "undefined" ||
    typeof crypto.subtle === "undefined" ||
    typeof crypto.subtle.digest !== "function"
  ) {
    throw unsupportedWebCrypto();
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const digestBytes = readU8Array(digest);
  let hex = "";
  for (let index = 0; index < digestBytes.byteLength; index += 1) {
    hex += (digestBytes[index] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

async function inspectWorkspaceArchiveImpl(
  file: BlobLike,
  options: WorkspaceArchiveInspectionOptions | undefined,
  cancelledPromise: Promise<never>,
  active: ActiveState,
): Promise<WorkspaceArchiveInspectionReport> {
  const signal = options?.signal;
  const onProgress = options?.onProgress;

  const assertActive = (): void => {
    if (active.signalAborted || signal?.aborted) throw cancelled(MSG_CANCELLED);
    if (performance.now() >= active.deadlineAt) active.deadlineFired = true;
    if (active.deadlineFired) throw limit(MSG_TIMEOUT);
  };

  const cancellable = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          assertActive();
          return operation();
        }),
        cancelledPromise,
      ]);
    } catch (error) {
      assertActive();
      throw toInspectionError(error);
    }
  };

  const readBytes = async (start: number, end: number): Promise<Uint8Array> => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw invalid(MSG_STRUCTURE);
    }
    assertActive();
    if (end > file.size) throw invalid(MSG_STRUCTURE);
    const blob = file.slice(start, end);
    const buffer = await cancellable(() => blob.arrayBuffer());
    assertActive();
    if (buffer.byteLength !== end - start) throw invalid(MSG_STRUCTURE);
    return readU8Array(buffer);
  };

  const publish = (
    phase: WorkspaceArchiveInspectionProgress["phase"],
    verifiedEntries: number,
    verifiedBytes: number,
  ): void => {
    assertActive();
    if (!onProgress) return;
    try {
      onProgress({
        phase,
        verifiedEntries,
        totalEntries: active.totalEntries,
        verifiedBytes,
        totalBytes: active.totalBytes,
      });
    } catch {
      // Progress observers must not influence archive integrity.
    }
  };

  const parseEocd = async (): Promise<ParsedEocd> => {
    if (file.size < END_OF_CENTRAL_DIRECTORY_LENGTH) throw invalid(MSG_STRUCTURE);
    if (file.size > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) throw limit(MSG_ARCHIVE_LIMIT);
    const scanLength = Math.min(file.size, MAX_EOCD_TAIL_BYTES);
    const tail = await readBytes(file.size - scanLength, file.size);
    let eocdTailOffset = -1;
    for (let offset = tail.byteLength - END_OF_CENTRAL_DIRECTORY_LENGTH; offset >= 0; offset -= 1) {
      if (u32(tail, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
      const commentLength = u16(tail, offset + 20);
      if (offset + END_OF_CENTRAL_DIRECTORY_LENGTH + commentLength === tail.byteLength) {
        eocdTailOffset = offset;
        break;
      }
    }
    if (eocdTailOffset < 0) throw invalid(MSG_STRUCTURE);

    const disk = u16(tail, eocdTailOffset + 4);
    const cdDisk = u16(tail, eocdTailOffset + 6);
    const diskEntries = u16(tail, eocdTailOffset + 8);
    const totalEntries = u16(tail, eocdTailOffset + 10);
    const cdSize = u32(tail, eocdTailOffset + 12);
    const cdOffset = u32(tail, eocdTailOffset + 16);
    const eocdOffset = file.size - scanLength + eocdTailOffset;

    if (
      disk === 0xffff ||
      cdDisk === 0xffff ||
      diskEntries === 0xffff ||
      totalEntries === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    ) {
      throw unsupported(MSG_ZIP64);
    }
    if (disk !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) {
      throw unsupported(MSG_MULTI_DISK);
    }
    if (totalEntries > WORKSPACE_EXPORT_MAX_ENTRIES) throw limit(MSG_ENTRY_COUNT_LIMIT);
    if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) throw limit(MSG_CENTRAL_LIMIT);
    if (cdOffset > file.size || cdSize > file.size - cdOffset) throw invalid(MSG_STRUCTURE);
    if (cdOffset + cdSize !== eocdOffset) throw invalid(MSG_STRUCTURE);

    return { cdOffset, cdSize, totalEntries, eocdOffset };
  };

  const eocd = await parseEocd();
  assertActive();

  const cdBytes = await readBytes(eocd.cdOffset, eocd.cdOffset + eocd.cdSize);
  assertActive();
  const centralEntries: ParsedCentralEntry[] = [];
  const seenPaths = new Set<string>();
  let cdPosition = 0;
  for (let index = 0; index < eocd.totalEntries; index += 1) {
    if (cdPosition > cdBytes.byteLength - CENTRAL_HEADER_LENGTH) throw invalid(MSG_STRUCTURE);
    if (u32(cdBytes, cdPosition) !== CENTRAL_HEADER_SIGNATURE) throw invalid(MSG_STRUCTURE);
    const versionNeeded = u16(cdBytes, cdPosition + 6);
    const flags = u16(cdBytes, cdPosition + 8);
    const method = u16(cdBytes, cdPosition + 10);
    const crc = u32(cdBytes, cdPosition + 16);
    const compressedSize = u32(cdBytes, cdPosition + 20);
    const uncompressedSize = u32(cdBytes, cdPosition + 24);
    const nameLength = u16(cdBytes, cdPosition + 28);
    const extraLength = u16(cdBytes, cdPosition + 30);
    const commentLength = u16(cdBytes, cdPosition + 32);
    const diskStart = u16(cdBytes, cdPosition + 34);
    const externalAttributes = u32(cdBytes, cdPosition + 38);
    const localHeaderOffset = u32(cdBytes, cdPosition + 42);
    const nameStart = cdPosition + CENTRAL_HEADER_LENGTH;
    const nameEnd = nameStart + nameLength;
    const extraEnd = nameEnd + extraLength;
    const entryEnd = extraEnd + commentLength;

    if (nameLength > MAX_ARCHIVE_PATH_BYTES) throw invalid(MSG_PATH);
    if (entryEnd > cdBytes.byteLength) throw invalid(MSG_STRUCTURE);
    if (versionNeeded > 20) throw unsupported(MSG_VERSION);
    if ((flags & ~ALLOWED_FLAG_BITS) !== 0) {
      throw (flags & 1) !== 0 ? unsupported(MSG_ENCRYPTION) : unsupported(MSG_FLAGS);
    }
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw unsupported(MSG_ZIP64);
    }
    if (method !== 0) throw unsupported(MSG_COMPRESSION);
    if (extraLength !== 0) throw unsupported(MSG_EXTRA_FIELDS);
    if (diskStart !== 0) throw unsupported(MSG_MULTI_DISK);
    const directoryAttributes =
      (externalAttributes & 0x10) !== 0 ||
      ((externalAttributes >>> 16) & 0xf000) === 0o040000 ||
      ((externalAttributes >>> 16) & 0xf000) === 0o120000;
    if (directoryAttributes) throw invalid(MSG_PATH);

    const nameBytes = cdBytes.subarray(nameStart, nameEnd);
    const name = decodeArchivePath(nameBytes, flags);
    if (!isSafeArchivePath(name)) throw invalid(MSG_PATH);
    if (seenPaths.has(name)) throw invalid(MSG_DUPLICATE);
    seenPaths.add(name);
    if (name.endsWith("/")) throw invalid(MSG_PATH);

    if (compressedSize !== uncompressedSize) throw invalid(MSG_STRUCTURE);
    if (name === MANIFEST_PATH && compressedSize > MAX_MANIFEST_BYTES) {
      throw limit(MSG_MANIFEST_SIZE_LIMIT, name);
    }
    if (name === NOTICE_PATH && compressedSize > MAX_NOTICE_BYTES) {
      throw limit(MSG_NOTICE_SIZE_LIMIT, name);
    }
    if (compressedSize > WORKSPACE_EXPORT_MAX_SOURCE_BYTES) {
      throw limit(MSG_ENTRY_SIZE_LIMIT, name);
    }

    centralEntries.push({
      name,
      nameBytes,
      flags,
      method,
      crc,
      size: compressedSize,
      localHeaderOffset,
      dataOffset: 0,
      end: 0,
    });
    cdPosition = entryEnd;
  }
  if (cdPosition !== cdBytes.byteLength) throw invalid(MSG_STRUCTURE);
  assertActive();

  const parsedEntries: ParsedCentralEntry[] = [];
  for (const centralEntry of centralEntries) {
    assertActive();
    const localLength = LOCAL_HEADER_LENGTH + centralEntry.nameBytes.byteLength;
    if (
      centralEntry.localHeaderOffset > eocd.cdOffset ||
      localLength > eocd.cdOffset - centralEntry.localHeaderOffset
    ) {
      throw invalid(MSG_STRUCTURE);
    }
    const localBytes = await readBytes(
      centralEntry.localHeaderOffset,
      centralEntry.localHeaderOffset + localLength,
    );
    if (u32(localBytes, 0) !== LOCAL_HEADER_SIGNATURE) throw invalid(MSG_STRUCTURE);
    const localVersion = u16(localBytes, 4);
    const localFlags = u16(localBytes, 6);
    const localMethod = u16(localBytes, 8);
    const localCrc = u32(localBytes, 14);
    const localCompressedSize = u32(localBytes, 18);
    const localUncompressedSize = u32(localBytes, 22);
    const localNameLength = u16(localBytes, 26);
    const localExtraLength = u16(localBytes, 28);
    if (localVersion > 20) throw unsupported(MSG_VERSION);
    if (localFlags !== centralEntry.flags) throw invalid(MSG_STRUCTURE);
    if (localMethod !== centralEntry.method) throw invalid(MSG_STRUCTURE);
    if (localNameLength !== centralEntry.nameBytes.byteLength) throw invalid(MSG_STRUCTURE);
    if (localExtraLength !== 0) throw unsupported(MSG_EXTRA_FIELDS);
    if (!bytesEqual(localBytes.subarray(30, 30 + localNameLength), centralEntry.nameBytes)) {
      throw invalid(MSG_STRUCTURE);
    }
    if ((localFlags & DATA_DESCRIPTOR_FLAG) !== 0) {
      if (localCrc !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0) {
        throw invalid(MSG_STRUCTURE);
      }
    } else if (
      localCrc !== centralEntry.crc ||
      localCompressedSize !== centralEntry.size ||
      localUncompressedSize !== centralEntry.size
    ) {
      throw invalid(MSG_STRUCTURE);
    }

    const dataOffset =
      centralEntry.localHeaderOffset + LOCAL_HEADER_LENGTH + localNameLength + localExtraLength;
    if (dataOffset > eocd.cdOffset || centralEntry.size > eocd.cdOffset - dataOffset) {
      throw invalid(MSG_STRUCTURE);
    }
    parsedEntries.push({ ...centralEntry, dataOffset });
  }

  const sorted = [...parsedEntries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  for (let index = 0; index < sorted.length; index += 1) {
    assertActive();
    const entry = parsedEntryAt(sorted, index);
    if (index === 0) {
      if (entry.localHeaderOffset !== 0) throw invalid(MSG_STRUCTURE);
    } else {
      const previous = parsedEntryAt(sorted, index - 1);
      if (entry.localHeaderOffset !== previous.end) throw invalid(MSG_STRUCTURE);
    }
    const dataEnd = entry.dataOffset + entry.size;
    if (dataEnd > eocd.cdOffset) throw invalid(MSG_STRUCTURE);
    const nextBoundary =
      index + 1 < sorted.length
        ? parsedEntryAt(sorted, index + 1).localHeaderOffset
        : eocd.cdOffset;
    if ((entry.flags & DATA_DESCRIPTOR_FLAG) !== 0) {
      const descriptorStart = dataEnd;
      const available = nextBoundary - descriptorStart;
      if (available === 16) {
        const descriptorBytes = await readBytes(descriptorStart, descriptorStart + 16);
        if (u32(descriptorBytes, 0) !== DATA_DESCRIPTOR_SIGNATURE) throw invalid(MSG_DESCRIPTOR);
        if (
          u32(descriptorBytes, 4) !== entry.crc ||
          u32(descriptorBytes, 8) !== entry.size ||
          u32(descriptorBytes, 12) !== entry.size
        ) {
          throw invalid(MSG_DESCRIPTOR);
        }
        entry.descriptor = { offset: descriptorStart, length: 16 };
        entry.end = descriptorStart + 16;
      } else if (available === 12) {
        const descriptorBytes = await readBytes(descriptorStart, descriptorStart + 12);
        if (
          u32(descriptorBytes, 0) !== entry.crc ||
          u32(descriptorBytes, 4) !== entry.size ||
          u32(descriptorBytes, 8) !== entry.size
        ) {
          throw invalid(MSG_DESCRIPTOR);
        }
        entry.descriptor = { offset: descriptorStart, length: 12 };
        entry.end = descriptorStart + 12;
      } else {
        throw invalid(MSG_DESCRIPTOR);
      }
    } else {
      entry.end = dataEnd;
    }
  }
  if (sorted.length > 0 && parsedEntryAt(sorted, sorted.length - 1).end !== eocd.cdOffset) {
    throw invalid(MSG_STRUCTURE);
  }
  assertActive();

  const byPath = new Map(sorted.map((entry) => [entry.name, entry]));
  const manifestEntry = byPath.get(MANIFEST_PATH);
  if (!manifestEntry) throw invalid(MSG_MANIFEST);
  if (manifestEntry.size > MAX_MANIFEST_BYTES) throw limit(MSG_MANIFEST_SIZE_LIMIT);

  const manifestBytes = await readBytes(
    manifestEntry.dataOffset,
    manifestEntry.dataOffset + manifestEntry.size,
  );
  if (crc32(manifestBytes) !== manifestEntry.crc) {
    throw invalid(MSG_INTEGRITY, MANIFEST_PATH);
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(UTF8_DECODER.decode(manifestBytes));
  } catch {
    throw invalid(MSG_MANIFEST);
  }
  if (typeof rawManifest !== "object" || rawManifest === null) throw invalid(MSG_MANIFEST);
  const rawRecord = rawManifest as Record<string, unknown>;
  const rawFormat = rawRecord.format;
  const rawVersion = rawRecord.version;
  const rawStateVersion = rawRecord.stateVersion;
  if (rawFormat !== "nexestra.workspace-export" || rawVersion !== 1 || rawStateVersion !== 7) {
    if (rawFormat !== undefined || rawVersion !== undefined || rawStateVersion !== undefined) {
      throw unsupported(MSG_MANIFEST_UNSUPPORTED);
    }
    throw invalid(MSG_MANIFEST);
  }
  const parsedManifest = WorkspaceExportManifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) throw invalid(MSG_MANIFEST);
  const manifest = parsedManifest.data;

  const exclusions = new Set(manifest.excluded);
  if (
    manifest.excluded.length !== REQUIRED_EXCLUSIONS.length ||
    REQUIRED_EXCLUSIONS.some((name) => !exclusions.has(name))
  ) {
    throw invalid(MSG_MANIFEST);
  }

  const manifestPaths = new Set<string>();
  let sourceBytes = 0;
  let totalBytes = 0;
  for (const manifestEntryItem of manifest.entries) {
    if (!isSafeArchivePath(manifestEntryItem.path)) {
      throw invalid(MSG_PATH);
    }
    if (manifestPaths.has(manifestEntryItem.path)) {
      throw invalid(MSG_MANIFEST, manifestEntryItem.path);
    }
    manifestPaths.add(manifestEntryItem.path);
    const zipEntry = byPath.get(manifestEntryItem.path);
    if (!zipEntry) throw invalid(MSG_MANIFEST_COVERAGE, manifestEntryItem.path);
    if (zipEntry.size !== manifestEntryItem.bytes) {
      throw invalid(MSG_MANIFEST_COVERAGE, manifestEntryItem.path);
    }
    if (!isConsistentEntryKind(manifestEntryItem, manifest.workspace.id)) {
      throw invalid(MSG_KIND, manifestEntryItem.path);
    }
    totalBytes += manifestEntryItem.bytes;
    if (manifestEntryItem.kind !== "notice") sourceBytes += manifestEntryItem.bytes;
  }
  if (manifestPaths.size !== sorted.length - 1) throw invalid(MSG_MANIFEST_COVERAGE);
  for (const entry of sorted) {
    if (entry.name !== MANIFEST_PATH && !manifestPaths.has(entry.name)) {
      throw invalid(MSG_MANIFEST_COVERAGE, entry.name);
    }
  }
  const noticeZipEntry = byPath.get(NOTICE_PATH);
  const stateZipEntry = byPath.get(STATE_PATH);
  if (!noticeZipEntry || !stateZipEntry) throw invalid(MSG_MANIFEST_COVERAGE);
  if (sourceBytes > WORKSPACE_EXPORT_MAX_SOURCE_BYTES) throw limit(MSG_SOURCE_SIZE_LIMIT);
  if (totalBytes > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) throw limit(MSG_ARCHIVE_LIMIT);

  active.totalEntries = manifest.entries.length;
  active.totalBytes = totalBytes;
  publish("reading", 0, 0);

  const expectedSha256 = new Map(manifest.entries.map((entry) => [entry.path, entry.sha256]));
  let verifiedEntries = 0;
  let verifiedBytes = 0;
  for (const entry of sorted) {
    assertActive();
    if (entry.name === MANIFEST_PATH) continue;
    const payload = await readBytes(entry.dataOffset, entry.dataOffset + entry.size);
    if (crc32(payload) !== entry.crc) throw invalid(MSG_INTEGRITY, entry.name);
    assertActive();
    const actualSha256 = await sha256Hex(payload);
    assertActive();
    const expected = expectedSha256.get(entry.name);
    if (!expected || expected !== actualSha256) throw invalid(MSG_HASH, entry.name);
    verifiedEntries += 1;
    verifiedBytes += entry.size;
    publish("verifying", verifiedEntries, verifiedBytes);
  }

  assertActive();
  const report: WorkspaceArchiveInspectionReport = {
    manifest,
    archiveBytes: file.size,
    payloadBytes: totalBytes,
    ...(options?.expectedWorkspace
      ? {
          workspaceMatch: {
            id: manifest.workspace.id === options.expectedWorkspace.id,
            name: manifest.workspace.name === options.expectedWorkspace.name,
          },
        }
      : {}),
  };
  const parsedReport = WorkspaceArchiveInspectionReportSchema.safeParse(report);
  if (!parsedReport.success) throw invalid(MSG_INTERNAL);
  assertActive();
  return parsedReport.data;
}

export async function inspectWorkspaceArchive(
  file: Blob,
  options?: WorkspaceArchiveInspectionOptions,
): Promise<WorkspaceArchiveInspectionReport> {
  const signal = options?.signal;
  if (signal?.aborted) throw cancelled(MSG_CANCELLED);
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw invalid(MSG_STRUCTURE);
  const active: ActiveState = {
    deadlineFired: false,
    signalAborted: false,
    deadlineAt: performance.now() + WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS,
    totalEntries: 0,
    totalBytes: 0,
  };
  let cancelReject!: (error: WorkspaceArchiveInspectionError) => void;
  const cancelledPromise = new Promise<never>((_, reject) => {
    cancelReject = reject;
  });
  void cancelledPromise.catch(() => undefined);
  const onAbort = (): void => {
    active.signalAborted = true;
    cancelReject(cancelled(MSG_CANCELLED));
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const deadlineTimer = setTimeout(() => {
    active.deadlineFired = true;
    cancelReject(limit(MSG_TIMEOUT));
  }, WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS);

  try {
    return await Promise.race([
      inspectWorkspaceArchiveImpl(file as BlobLike, options, cancelledPromise, active),
      cancelledPromise,
    ]);
  } catch (error) {
    throw toInspectionError(error);
  } finally {
    clearTimeout(deadlineTimer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
