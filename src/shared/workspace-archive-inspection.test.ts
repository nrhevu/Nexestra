import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWorkspaceExportArchive } from "../server/workspace-export-archive.js";
import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_MAX_ENTRIES,
  type WorkspaceExportEntry,
  type WorkspaceExportManifest,
} from "./contracts.js";
import {
  inspectWorkspaceArchive,
  WorkspaceArchiveInspectionError,
} from "./workspace-archive-inspection.js";
import {
  WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS,
  type WorkspaceArchiveInspectionProgress,
} from "./workspace-archive-inspection-contracts.js";

const NOTICE_PATH = "NOTICE.txt";
const MANIFEST_PATH = "manifest.json";
const STATE_PATH = "state.json";
const DEFAULT_WORKSPACE: { id: string; name: string } = { id: "w1", name: "Workspace" };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024;

interface FixtureSource {
  path: string;
  kind: "metadata" | "transcript" | "upload" | "document";
  bytes: Uint8Array;
}

interface FixturePayload {
  name: string;
  bytes: Uint8Array;
  flags?: number;
}

interface FixtureOptions {
  workspace?: { id: string; name: string };
  descriptor?: boolean;
  descriptorLength?: 12 | 16;
  manifestMutator?: (manifest: WorkspaceExportManifest) => WorkspaceExportManifest;
  payloadFlags?: number;
}

interface EntryLocation {
  cdEntryOffset: number;
  localOffset: number;
  dataOffset: number;
  size: number;
  crc: number;
  descriptorOffset: number;
}

class FakeBlob {
  reads = 0;
  protected readonly data: Uint8Array | null;
  protected readonly hangRange: readonly [number, number] | null;
  protected readonly sizeOverride: number | undefined;

  constructor(
    data: Uint8Array | null,
    hangRange: readonly [number, number] | null = null,
    sizeOverride?: number,
  ) {
    this.data = data;
    this.hangRange = hangRange;
    this.sizeOverride = sizeOverride;
  }

  get size(): number {
    return this.sizeOverride ?? this.data?.byteLength ?? 0;
  }

  slice(start = 0, end = this.size): FakeBlob {
    this.reads += 1;
    const from = Math.max(0, start);
    const to = Math.min(this.size, end);
    if (this.data === null) return new FakeBlob(null, null, Math.max(0, to - from));
    const sub = this.data.subarray(from, to);
    if (this.hangRange !== null) {
      const hangStart = Math.max(this.hangRange[0], from);
      const hangEnd = Math.min(this.hangRange[1], to);
      if (hangStart < hangEnd) {
        return new FakeBlob(sub, [hangStart - from, hangEnd - from]);
      }
    }
    return new FakeBlob(sub, null);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.hangRange !== null) {
      return new Promise<ArrayBuffer>(() => {});
    }
    if (this.data === null) return new ArrayBuffer(this.size);
    const copy = new Uint8Array(this.data.byteLength);
    copy.set(this.data);
    return copy.buffer;
  }
}

class ShortReadBlob extends FakeBlob {
  override slice(start = 0, end = this.size): ShortReadBlob {
    this.reads += 1;
    const from = Math.max(0, start);
    const to = Math.min(this.size, end);
    if (this.data === null) return new ShortReadBlob(null, null, Math.max(0, to - from));
    return new ShortReadBlob(this.data.subarray(from, to), null);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = await super.arrayBuffer();
    return buffer.slice(0, Math.max(0, buffer.byteLength - 1)) as ArrayBuffer;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) & 0xffff;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function buildStoredZip(
  payloads: FixturePayload[],
  options: { descriptor?: boolean; descriptorLength?: 12 | 16 } = {},
): Uint8Array {
  const descriptor = options.descriptor ?? true;
  const descriptorLength = options.descriptorLength ?? 16;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const records: Array<{
    nameBytes: Buffer;
    flags: number;
    crc: number;
    size: number;
    localOffset: number;
    descriptorLength: number;
  }> = [];
  let offset = 0;

  for (const payload of payloads) {
    const nameBytes = Buffer.from(encoder.encode(payload.name));
    const data = Buffer.from(payload.bytes);
    const utf8Flag = nameBytes.byteLength !== payload.name.length ? 0x0800 : 0;
    const flags = (payload.flags ?? utf8Flag | (descriptor ? 0x0008 : 0)) & 0xffff;
    const hasDescriptor = (flags & 0x0008) !== 0;
    const size = data.byteLength;
    const crc = crc32(data) >>> 0;

    const local = Buffer.alloc(30 + nameBytes.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    if (!hasDescriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(nameBytes.byteLength, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    localParts.push(local, data);

    let entryDescriptorLength = 0;
    if (hasDescriptor) {
      entryDescriptorLength = descriptorLength;
      const descriptorBytes = Buffer.alloc(descriptorLength);
      let position = 0;
      if (descriptorLength === 16) {
        descriptorBytes.writeUInt32LE(0x08074b50, 0);
        position = 4;
      } else if (descriptorLength !== 12) {
        throw new Error("descriptor must be 12 or 16 bytes");
      }
      descriptorBytes.writeUInt32LE(crc, position);
      descriptorBytes.writeUInt32LE(size, position + 4);
      descriptorBytes.writeUInt32LE(size, position + 8);
      localParts.push(descriptorBytes);
    }

    records.push({
      nameBytes,
      flags,
      crc,
      size,
      localOffset: offset,
      descriptorLength: entryDescriptorLength,
    });
    offset += local.byteLength + data.byteLength + entryDescriptorLength;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const record of records) {
    const central = Buffer.alloc(46 + record.nameBytes.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(record.flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(record.crc, 16);
    central.writeUInt32LE(record.size, 20);
    central.writeUInt32LE(record.size, 24);
    central.writeUInt16LE(record.nameBytes.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(record.localOffset, 42);
    record.nameBytes.copy(central, 46);
    centralParts.push(central);
    cdSize += central.byteLength;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, eocd]));
}

function makeManifest(
  entries: WorkspaceExportEntry[],
  workspace: { id: string; name: string },
): WorkspaceExportManifest {
  return {
    format: "nexestra.workspace-export",
    version: 1,
    createdAt: "2026-09-09T00:00:00.000Z",
    workspace,
    stateVersion: 7,
    redaction: "known-credentials",
    importSupported: false,
    excluded: [
      "credentials",
      "harness-auth",
      "repository-files",
      "browser-state",
      "unreferenced-files",
    ],
    entries,
  };
}

function buildFixture(
  sources: FixtureSource[],
  options: FixtureOptions = {},
): { bytes: Uint8Array; manifest: WorkspaceExportManifest } {
  const workspace = options.workspace ?? DEFAULT_WORKSPACE;
  const noticeBytes = encoder.encode("Nexestra workspace export notice.\n");
  const entries: WorkspaceExportEntry[] = [
    {
      path: NOTICE_PATH,
      kind: "notice",
      bytes: noticeBytes.byteLength,
      sha256: sha256Hex(noticeBytes),
    },
    ...sources.map((source) => ({
      path: source.path,
      kind: source.kind,
      bytes: source.bytes.byteLength,
      sha256: sha256Hex(source.bytes),
    })),
  ];
  let manifest = makeManifest(entries, workspace);
  if (options.manifestMutator) manifest = options.manifestMutator(manifest);
  const manifestBytes = encoder.encode(JSON.stringify(manifest, null, 2));
  const payloads: FixturePayload[] = [{ name: NOTICE_PATH, bytes: noticeBytes }];
  for (const source of sources) {
    const payload: FixturePayload = { name: source.path, bytes: source.bytes };
    if (options.payloadFlags !== undefined) payload.flags = options.payloadFlags;
    payloads.push(payload);
  }
  payloads.push({ name: MANIFEST_PATH, bytes: manifestBytes });
  return {
    bytes: buildStoredZip(payloads, {
      descriptor: options.descriptor ?? true,
      descriptorLength: options.descriptorLength ?? 16,
    }),
    manifest,
  };
}

function baseSources(workspace: { id: string; name: string } = DEFAULT_WORKSPACE): FixtureSource[] {
  return [
    {
      path: STATE_PATH,
      kind: "metadata",
      bytes: encoder.encode(JSON.stringify({ workspaceId: workspace.id })),
    },
    { path: "threads/t1.jsonl", kind: "transcript", bytes: encoder.encode('{"sequence":1}\n') },
    { path: "artifacts/t1/art-1", kind: "upload", bytes: new Uint8Array([0, 255, 1]) },
    {
      path: `workspaces/${workspace.id}/knowledge/doc-1/document`,
      kind: "document",
      bytes: new Uint8Array([1, 2, 3, 4]),
    },
  ];
}

async function buildRealArchive(
  sources: FixtureSource[],
  workspace: { id: string; name: string } = DEFAULT_WORKSPACE,
): Promise<{ bytes: Uint8Array; manifest: WorkspaceExportManifest }> {
  const archive = await buildWorkspaceExportArchive({
    workspace,
    createdAt: "2026-09-09T00:00:00.000Z",
    entries: (async function* () {
      for (const source of sources) {
        yield {
          path: source.path,
          kind: source.kind,
          chunks: (async function* () {
            if (source.bytes.byteLength > 0) yield source.bytes;
          })(),
        };
      }
    })(),
  });
  try {
    const fileBytes = await readFile(archive.path);
    return {
      bytes: new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength),
      manifest: archive.manifest,
    };
  } finally {
    await archive.dispose();
  }
}

function findEocd(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (readU32(bytes, offset) !== 0x06054b50) continue;
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  throw new Error("fixture did not contain an end of central directory record");
}

function centralEntryCount(bytes: Uint8Array): number {
  return readU16(bytes, findEocd(bytes) + 10);
}

function locateEntry(bytes: Uint8Array, name: string): EntryLocation {
  const eocd = findEocd(bytes);
  const cdOffset = readU32(bytes, eocd + 16);
  const total = readU16(bytes, eocd + 10);
  let position = cdOffset;
  for (let index = 0; index < total; index += 1) {
    if (readU32(bytes, position) !== 0x02014b50) throw new Error("fixture central header missing");
    const nameLength = readU16(bytes, position + 28);
    const extraLength = readU16(bytes, position + 30);
    const commentLength = readU16(bytes, position + 32);
    const localOffset = readU32(bytes, position + 42);
    const entryName = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
    if (entryName === name) {
      const localNameLength = readU16(bytes, localOffset + 26);
      const localExtraLength = readU16(bytes, localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const size = readU32(bytes, position + 20);
      return {
        cdEntryOffset: position,
        localOffset,
        dataOffset,
        size,
        crc: readU32(bytes, position + 16),
        descriptorOffset: dataOffset + size,
      };
    }
    position += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`fixture did not contain entry ${name}`);
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart]);
}

function withEocdCount(bytes: Uint8Array, count: number): Uint8Array {
  const mutated = copyBytes(bytes);
  const eocd = findEocd(mutated);
  writeU16(mutated, eocd + 8, count);
  writeU16(mutated, eocd + 10, count);
  return mutated;
}

function withEocdDisk(bytes: Uint8Array, disk: number): Uint8Array {
  const mutated = copyBytes(bytes);
  writeU16(mutated, findEocd(mutated) + 4, disk);
  return mutated;
}

function withCdSize(bytes: Uint8Array, cdSize: number): Uint8Array {
  const mutated = copyBytes(bytes);
  writeU32(mutated, findEocd(mutated) + 12, cdSize);
  return mutated;
}

function insertGapBeforeCentral(bytes: Uint8Array, gapLength: number): Uint8Array {
  const eocd = findEocd(bytes);
  const cdOffset = readU32(bytes, eocd + 16);
  const gap = new Uint8Array(gapLength).fill(0xaa);
  const mutated = new Uint8Array(bytes.byteLength + gapLength);
  mutated.set(bytes.subarray(0, cdOffset), 0);
  mutated.set(gap, cdOffset);
  mutated.set(bytes.subarray(cdOffset), cdOffset + gapLength);
  writeU32(mutated, findEocd(mutated) + 16, cdOffset + gapLength);
  return mutated;
}

describe("workspace archive inspection engine", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts a real builder archive including empty transcripts and binary payloads", async () => {
    const sources: FixtureSource[] = [
      { path: STATE_PATH, kind: "metadata", bytes: encoder.encode('{"workspaceId":"w1"}') },
      { path: "threads/empty.jsonl", kind: "transcript", bytes: new Uint8Array() },
      {
        path: "threads/thread-1.jsonl",
        kind: "transcript",
        bytes: encoder.encode('{"sequence":1}\n'),
      },
      {
        path: "artifacts/thread-1/art-1",
        kind: "upload",
        bytes: new Uint8Array([0, 255, 1, 0, 128]),
      },
      {
        path: "workspaces/w1/knowledge/doc-1/document",
        kind: "document",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00]),
      },
      {
        path: "workspaces/w1/knowledge/doc-1/revisions/rev-1",
        kind: "document",
        bytes: encoder.encode("revision bytes"),
      },
    ];
    const built = await buildRealArchive(sources);
    const progress: WorkspaceArchiveInspectionProgress[] = [];
    const report = await inspectWorkspaceArchive(blobOf(built.bytes), {
      onProgress: (item) => progress.push(item),
    });

    expect(report.manifest.entries).toEqual(built.manifest.entries);
    expect(report.archiveBytes).toBe(built.bytes.byteLength);
    expect(report.payloadBytes).toBe(
      built.manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0),
    );
    expect(report.manifest.entries.length).toBe(centralEntryCount(built.bytes) - 1);
    expect(report.restorePlan).toMatchObject({
      importSupported: false,
      counts: {
        threads: 2,
        knowledge: 1,
        agents: 0,
        tasks: 0,
        assignments: 0,
      },
      pathConflicts: { checked: false, paths: [] },
      unsupportedEntries: [],
    });

    const extracted = unzipSync(built.bytes);
    for (const entry of report.manifest.entries) {
      const payload = extracted[entry.path];
      expect(payload, entry.path).toBeDefined();
      if (payload === undefined) throw new Error(`fixture missing payload ${entry.path}`);
      expect(payload.byteLength, entry.path).toBe(entry.bytes);
      expect(sha256Hex(payload), entry.path).toBe(entry.sha256);
    }

    expect(progress.at(-1)).toMatchObject({
      phase: "verifying",
      verifiedEntries: report.manifest.entries.length,
      verifiedBytes: report.payloadBytes,
      totalEntries: report.manifest.entries.length,
      totalBytes: report.payloadBytes,
    });
  });

  it("reports whether a verified archive belongs to the expected workspace", async () => {
    const sources: FixtureSource[] = [
      { path: STATE_PATH, kind: "metadata", bytes: encoder.encode('{"workspaceId":"w1"}') },
    ];
    const built = await buildRealArchive(sources);

    const matching = await inspectWorkspaceArchive(blobOf(built.bytes), {
      expectedWorkspace: { id: "w1", name: "Workspace" },
    });
    expect(matching.workspaceMatch).toEqual({ id: true, name: true });

    const different = await inspectWorkspaceArchive(blobOf(built.bytes), {
      expectedWorkspace: { id: "other", name: "Workspace" },
    });
    expect(different.workspaceMatch).toEqual({ id: false, name: true });
  });

  it("accepts no-descriptor stored layout and 12-byte descriptors with UTF-8 paths", async () => {
    const sources: FixtureSource[] = [
      { path: STATE_PATH, kind: "metadata", bytes: encoder.encode('{"ok":true}') },
      { path: "threads/你好.jsonl", kind: "transcript", bytes: encoder.encode("line\n") },
      {
        path: "workspaces/w1/knowledge/知识/document",
        kind: "document",
        bytes: new Uint8Array([0, 1, 255]),
      },
    ];
    const noDescriptor = buildFixture(sources, { descriptor: false });
    const noDescriptorReport = await inspectWorkspaceArchive(blobOf(noDescriptor.bytes));
    expect(noDescriptorReport.manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["threads/你好.jsonl", "workspaces/w1/knowledge/知识/document"]),
    );

    const twelve = buildFixture(baseSources(), { descriptor: true, descriptorLength: 12 });
    const twelveReport = await inspectWorkspaceArchive(blobOf(twelve.bytes));
    expect(twelveReport.archiveBytes).toBe(twelve.bytes.byteLength);

    const sixteen = buildFixture(baseSources(), { descriptor: true, descriptorLength: 16 });
    const sixteenReport = await inspectWorkspaceArchive(blobOf(sixteen.bytes));
    expect(sixteenReport.archiveBytes).toBe(sixteen.bytes.byteLength);
  });

  it("rejects altered payloads, CRCs, hashes, and manifest coverage", async () => {
    const fixture = buildFixture(baseSources(), { descriptor: false });
    const stateLocation = locateEntry(fixture.bytes, STATE_PATH);

    const alteredPayload = copyBytes(fixture.bytes);
    alteredPayload[stateLocation.dataOffset] = (alteredPayload[stateLocation.dataOffset] ?? 0) ^ 1;
    await expect(inspectWorkspaceArchive(blobOf(alteredPayload))).rejects.toMatchObject({
      code: "invalid",
      path: STATE_PATH,
    });

    const alteredCrc = copyBytes(fixture.bytes);
    writeU32(alteredCrc, stateLocation.cdEntryOffset + 16, stateLocation.crc ^ 0x12345678);
    await expect(inspectWorkspaceArchive(blobOf(alteredCrc))).rejects.toMatchObject({
      code: "invalid",
    });

    const wrongHash = buildFixture(baseSources(), {
      manifestMutator: (manifest) => ({
        ...manifest,
        entries: manifest.entries.map((entry) =>
          entry.path === STATE_PATH ? { ...entry, sha256: "0".repeat(64) } : entry,
        ),
      }),
    });
    await expect(inspectWorkspaceArchive(blobOf(wrongHash.bytes))).rejects.toMatchObject({
      code: "invalid",
      path: STATE_PATH,
    });

    const missingEntry = buildFixture(baseSources(), {
      manifestMutator: (manifest) => ({
        ...manifest,
        entries: manifest.entries.filter((entry) => entry.path !== STATE_PATH),
      }),
    });
    await expect(inspectWorkspaceArchive(blobOf(missingEntry.bytes))).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects duplicate, unsafe, and BOM-prefixed archive paths", async () => {
    const duplicate = buildStoredZip(
      [
        { name: "threads/t1.jsonl", bytes: encoder.encode("a") },
        { name: "threads/t1.jsonl", bytes: encoder.encode("b") },
      ],
      { descriptor: true },
    );
    await expect(inspectWorkspaceArchive(blobOf(duplicate))).rejects.toMatchObject({
      code: "invalid",
    });

    const unsafePaths = [
      "../escape",
      "/absolute",
      "a\\b",
      "a:b",
      `a${String.fromCharCode(0)}b`,
      "a//b",
      "a/./b",
      "a/../b",
    ];
    for (const path of unsafePaths) {
      const fixture = buildFixture(
        [{ path, kind: "transcript", bytes: encoder.encode("payload") }],
        { descriptor: false },
      );
      try {
        await inspectWorkspaceArchive(blobOf(fixture.bytes));
        expect.fail(`expected ${path} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceArchiveInspectionError);
        const inspectionError = error as WorkspaceArchiveInspectionError;
        expect(inspectionError.code).toBe("invalid");
        expect(inspectionError.path).toBeUndefined();
      }
    }

    const bomFixture = buildFixture(
      [
        {
          path: `${String.fromCharCode(0xfeff)}threads/t1.jsonl`,
          kind: "transcript",
          bytes: encoder.encode("x"),
        },
      ],
      { descriptor: false },
    );
    await expect(inspectWorkspaceArchive(blobOf(bomFixture.bytes))).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects local mismatches, layout violations, and invalid descriptors", async () => {
    const fixture = buildFixture(baseSources(), { descriptor: false });
    const stateLocation = locateEntry(fixture.bytes, STATE_PATH);
    const threadLocation = locateEntry(fixture.bytes, "threads/t1.jsonl");

    const localMismatch = copyBytes(fixture.bytes);
    writeU16(localMismatch, stateLocation.localOffset + 6, 0x0008);
    await expect(inspectWorkspaceArchive(blobOf(localMismatch))).rejects.toMatchObject({
      code: "invalid",
    });

    const overlapping = copyBytes(fixture.bytes);
    writeU32(overlapping, threadLocation.cdEntryOffset + 42, stateLocation.localOffset);
    await expect(inspectWorkspaceArchive(blobOf(overlapping))).rejects.toMatchObject({
      code: "invalid",
    });

    await expect(
      inspectWorkspaceArchive(blobOf(insertGapBeforeCentral(fixture.bytes, 5))),
    ).rejects.toMatchObject({ code: "invalid" });

    const prepended = new Uint8Array(fixture.bytes.byteLength + 4);
    prepended.set([0x55, 0xaa, 0x55, 0xaa], 0);
    prepended.set(fixture.bytes, 4);
    await expect(inspectWorkspaceArchive(blobOf(prepended))).rejects.toMatchObject({
      code: "invalid",
    });

    await expect(
      inspectWorkspaceArchive(blobOf(fixture.bytes.subarray(0, fixture.bytes.byteLength - 2))),
    ).rejects.toMatchObject({ code: "invalid" });

    const badOffset = copyBytes(fixture.bytes);
    writeU32(badOffset, findEocd(badOffset) + 16, readU32(badOffset, findEocd(badOffset) + 16) + 1);
    await expect(inspectWorkspaceArchive(blobOf(badOffset))).rejects.toMatchObject({
      code: "invalid",
    });

    const sixteen = buildFixture(baseSources(), { descriptor: true, descriptorLength: 16 });
    const sixteenLocation = locateEntry(sixteen.bytes, STATE_PATH);
    const mutatedSixteen = copyBytes(sixteen.bytes);
    writeU32(mutatedSixteen, sixteenLocation.descriptorOffset + 4, sixteenLocation.crc ^ 1);
    await expect(inspectWorkspaceArchive(blobOf(mutatedSixteen))).rejects.toMatchObject({
      code: "invalid",
    });

    const twelve = buildFixture(baseSources(), { descriptor: true, descriptorLength: 12 });
    const twelveLocation = locateEntry(twelve.bytes, STATE_PATH);
    const mutatedTwelve = copyBytes(twelve.bytes);
    writeU32(mutatedTwelve, twelveLocation.descriptorOffset + 8, twelveLocation.size + 1);
    await expect(inspectWorkspaceArchive(blobOf(mutatedTwelve))).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects unsupported compression, encryption, ZIP64, multi-disk, and header versions", async () => {
    const compressed = buildStoredZip([{ name: "x", bytes: encoder.encode("x") }], {
      descriptor: false,
    });
    writeU16(compressed, locateEntry(compressed, "x").cdEntryOffset + 10, 8);
    await expect(inspectWorkspaceArchive(blobOf(compressed))).rejects.toMatchObject({
      code: "unsupported",
    });

    const encrypted = buildStoredZip([{ name: "x", bytes: encoder.encode("x"), flags: 1 }], {
      descriptor: false,
    });
    await expect(inspectWorkspaceArchive(blobOf(encrypted))).rejects.toMatchObject({
      code: "unsupported",
    });

    const fixture = buildFixture(baseSources());
    await expect(
      inspectWorkspaceArchive(blobOf(withEocdCount(fixture.bytes, 0xffff))),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      inspectWorkspaceArchive(blobOf(withEocdDisk(fixture.bytes, 1))),
    ).rejects.toMatchObject({ code: "unsupported" });

    const oldVersion = copyBytes(fixture.bytes);
    writeU16(oldVersion, locateEntry(oldVersion, STATE_PATH).cdEntryOffset + 6, 45);
    await expect(inspectWorkspaceArchive(blobOf(oldVersion))).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("rejects advertised budgets and short Blob reads", async () => {
    const oversized = new FakeBlob(null, null, WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES + 1);
    await expect(inspectWorkspaceArchive(oversized as unknown as Blob)).rejects.toMatchObject({
      code: "limit",
    });

    const fixture = buildFixture(baseSources());
    await expect(
      inspectWorkspaceArchive(
        blobOf(withEocdCount(fixture.bytes, WORKSPACE_EXPORT_MAX_ENTRIES + 1)),
      ),
    ).rejects.toMatchObject({ code: "limit" });

    await expect(
      inspectWorkspaceArchive(blobOf(withCdSize(fixture.bytes, MAX_CENTRAL_DIRECTORY_BYTES + 1))),
    ).rejects.toMatchObject({ code: "limit" });

    const shortRead = new ShortReadBlob(fixture.bytes);
    await expect(inspectWorkspaceArchive(shortRead as unknown as Blob)).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("never slices or reads when the signal is already aborted", async () => {
    const fixture = buildFixture(baseSources());
    const blob = new FakeBlob(fixture.bytes);
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectWorkspaceArchive(blob as unknown as Blob, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(blob.reads).toBe(0);
  });

  it("rejects invalid Blob sizes before slicing or scheduling a read", async () => {
    for (const size of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      30.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const blob = new FakeBlob(null, null, size);
      await expect(inspectWorkspaceArchive(blob as unknown as Blob)).rejects.toMatchObject({
        code: "invalid",
      });
      expect(blob.reads).toBe(0);
    }
  });

  it("does not start a queued file read after an immediate cancellation", async () => {
    const fixture = buildFixture(baseSources());
    const blob = new FakeBlob(fixture.bytes);
    const controller = new AbortController();
    const read = vi.spyOn(FakeBlob.prototype, "arrayBuffer");
    try {
      const pending = inspectWorkspaceArchive(blob as unknown as Blob, {
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it("settles on signal cancellation while a read hangs", async () => {
    const fixture = buildFixture(baseSources());
    const manifestLocation = locateEntry(fixture.bytes, MANIFEST_PATH);
    const hanging = new FakeBlob(fixture.bytes, [
      manifestLocation.dataOffset,
      manifestLocation.dataOffset + manifestLocation.size,
    ]);
    const controller = new AbortController();
    const pending = inspectWorkspaceArchive(hanging as unknown as Blob, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("settles with a limit timeout on the core deadline", async () => {
    vi.useFakeTimers();
    try {
      const fixture = buildFixture(baseSources());
      const manifestLocation = locateEntry(fixture.bytes, MANIFEST_PATH);
      const hanging = new FakeBlob(fixture.bytes, [
        manifestLocation.dataOffset,
        manifestLocation.dataOffset + manifestLocation.size,
      ]);
      const pending = inspectWorkspaceArchive(hanging as unknown as Blob);
      void pending.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS + 10);
      await expect(pending).rejects.toMatchObject({ code: "limit" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish progress after cancellation releases a late digest", async () => {
    const fixture = buildFixture(baseSources());
    const controller = new AbortController();
    const progress: WorkspaceArchiveInspectionProgress[] = [];
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    let digestCalls = 0;
    let releaseDigest: (() => void) | undefined;
    const digestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        digestCalls += 1;
        const result = realDigest(algorithm, data);
        if (digestCalls >= 3) {
          await new Promise<void>((resolve) => {
            releaseDigest = resolve;
          });
        }
        return result;
      });
    try {
      const pending = inspectWorkspaceArchive(blobOf(fixture.bytes), {
        signal: controller.signal,
        onProgress: (item) => progress.push(item),
      });
      await vi.waitFor(() => {
        expect(progress.length).toBeGreaterThanOrEqual(2);
      });
      await vi.waitFor(() => {
        expect(releaseDigest).toBeDefined();
      });
      const captured = progress.length;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "cancelled" });
      releaseDigest?.();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(progress.length).toBe(captured);
    } finally {
      releaseDigest?.();
      digestSpy.mockRestore();
    }
  });

  it("reports unsupported when WebCrypto is unavailable", async () => {
    const fixture = buildFixture(baseSources());
    vi.stubGlobal("crypto", undefined);
    await expect(inspectWorkspaceArchive(blobOf(fixture.bytes))).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("exposes only safe bounded errors", async () => {
    const fixture = buildFixture(baseSources(), {
      manifestMutator: (manifest) => ({
        ...manifest,
        entries: manifest.entries.map((entry) =>
          entry.path === STATE_PATH ? { ...entry, sha256: "0".repeat(64) } : entry,
        ),
      }),
    });
    try {
      await inspectWorkspaceArchive(blobOf(fixture.bytes));
      expect.fail("expected inspection to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceArchiveInspectionError);
      const inspectionError = error as WorkspaceArchiveInspectionError;
      expect(["invalid", "unsupported", "limit", "cancelled"]).toContain(inspectionError.code);
      expect(inspectionError.message.length).toBeLessThanOrEqual(500);
      expect(inspectionError.message).not.toContain("0".repeat(8));
      expect(inspectionError.message).not.toContain(STATE_PATH);
    }
  });
});
