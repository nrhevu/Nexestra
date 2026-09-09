import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FlateError, ZipInputFile } from "fflate";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceExportManifestSchema } from "../shared/contracts.js";
import type { WorkspaceExportSourceEntry } from "./workspace-export-archive.js";
import {
  buildWorkspaceExportArchive,
  WorkspaceExportArchiveError,
} from "./workspace-export-archive.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const workspace = { id: "export-workspace", name: "Export workspace" };
const createdAt = "2026-09-09T00:00:00.000Z";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function source(
  path: string,
  chunks: Uint8Array[] = [],
  kind: WorkspaceExportSourceEntry["kind"] = "transcript",
): WorkspaceExportSourceEntry {
  return {
    path,
    kind,
    chunks: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  };
}

async function build(
  entries: WorkspaceExportSourceEntry[],
  overrides: {
    signal?: AbortSignal;
    limits?: {
      maxSourceBytes?: number;
      maxArchiveBytes?: number;
      maxEntries?: number;
      timeoutMs?: number;
    };
  } = {},
) {
  return buildWorkspaceExportArchive({
    workspace,
    createdAt,
    entries: (async function* () {
      for (const entry of entries) yield entry;
    })(),
    ...overrides,
  });
}

async function unzipArchive(path: string): Promise<Record<string, Uint8Array>> {
  const bytes = await readFile(path);
  return unzipSync(new Uint8Array(bytes));
}

async function disposeArchive(archive: { dispose(): Promise<void> } | null): Promise<void> {
  await archive?.dispose();
}

async function tempExportDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("nexestra-workspace-export-"));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWorkspaceExportArchive", () => {
  it("builds a complete ZIP whose entries match the manifest and SHA-256 digests", async () => {
    const alpha = source(
      "metadata/state.json",
      [new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d])],
      "metadata",
    );
    const beta = source("transcripts/general.jsonl", [
      new TextEncoder().encode("line one\n"),
      new TextEncoder().encode("line two\n"),
    ]);
    const gamma = source(
      "uploads/artifacts/photo.bin",
      [new Uint8Array([0, 1, 2, 250, 251, 252])],
      "upload",
    );

    const archive = await build([alpha, beta, gamma]);
    try {
      expect(await stat(archive.path)).toBeDefined();
      expect(archive.size).toBe((await readFile(archive.path)).byteLength);
      const parsed = WorkspaceExportManifestSchema.parse(archive.manifest);
      expect(parsed.entries.map((entry) => entry.path)).toEqual([
        "NOTICE.txt",
        alpha.path,
        beta.path,
        gamma.path,
      ]);
      expect(parsed.entries.map((entry) => entry.sha256)).toEqual([
        expect.anything(),
        sha256Hex(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d])),
        sha256Hex(new TextEncoder().encode("line one\nline two\n")),
        sha256Hex(new Uint8Array([0, 1, 2, 250, 251, 252])),
      ]);

      const unzipped = await unzipArchive(archive.path);
      const expectedPaths = [alpha.path, beta.path, gamma.path, "NOTICE.txt", "manifest.json"];
      expect(Object.keys(unzipped).sort()).toEqual([...expectedPaths].sort());
      for (const entry of parsed.entries) {
        if (entry.path === "NOTICE.txt") continue;
        expect(sha256Hex(unzipped[entry.path] ?? new Uint8Array())).toBe(entry.sha256);
      }

      const manifestText = new TextDecoder().decode(unzipped["manifest.json"]);
      expect(JSON.parse(manifestText)).toEqual(parsed);
    } finally {
      await disposeArchive(archive);
    }
  });

  it("supports empty payloads, nested binary chunks, and UTF-8 paths", async () => {
    const empty = source("transcripts/empty.jsonl", []);
    const nested = source("transcripts/工作区/会议记录.jsonl", [
      new Uint8Array([0xff, 0x00, 0x80]),
      new Uint8Array([0x01, 0x7f]),
    ]);
    const archive = await build([empty, nested]);
    try {
      const parsed = WorkspaceExportManifestSchema.parse(archive.manifest);
      const emptyEntry = parsed.entries.find((entry) => entry.path === empty.path);
      expect(emptyEntry).toMatchObject({ bytes: 0, sha256: sha256Hex(new Uint8Array()) });
      const nestedEntry = parsed.entries.find((entry) => entry.path === nested.path);
      expect(nestedEntry?.bytes).toBe(5);
      expect(nestedEntry?.sha256).toBe(sha256Hex(new Uint8Array([0xff, 0x00, 0x80, 0x01, 0x7f])));

      const unzipped = await unzipArchive(archive.path);
      expect(unzipped[empty.path]).toEqual(new Uint8Array());
      expect(unzipped[nested.path]).toEqual(new Uint8Array([0xff, 0x00, 0x80, 0x01, 0x7f]));
    } finally {
      await disposeArchive(archive);
    }
  });

  it("writes a notice that honestly documents exclusions, redaction, and import support", async () => {
    const archive = await build([
      source("metadata/state.json", [new TextEncoder().encode("{}")], "metadata"),
    ]);
    try {
      const unzipped = await unzipArchive(archive.path);
      const notice = new TextDecoder().decode(unzipped["NOTICE.txt"]);
      for (const category of [
        "credentials",
        "harness-auth",
        "repository-files",
        "browser-state",
        "unreferenced-files",
      ]) {
        expect(notice).toContain(category);
      }
      expect(notice).toContain(
        "Known credential values are redacted from metadata and transcripts.",
      );
      expect(notice).toContain("preserved byte-for-byte");
      expect(notice).toContain("Restore into Nexestra is not supported");
      expect(archive.manifest).toMatchObject({
        format: "nexestra.workspace-export",
        version: 1,
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
      });
      expect(archive.manifest.entries.some((entry) => entry.path === "manifest.json")).toBe(false);
      expect(archive.manifest.entries.some((entry) => entry.path === "NOTICE.txt")).toBe(true);
    } finally {
      await disposeArchive(archive);
    }
  });

  it("creates a private temp directory and 0600 ZIP file and dispose is idempotent", async () => {
    const archive = await build([]);
    const archivePath = archive.path;
    try {
      expect(archivePath.startsWith(join(tmpdir(), "nexestra-workspace-export-"))).toBe(true);
      expect((await stat(dirname(archivePath))).mode & 0o777).toBe(0o700);
      expect((await stat(archivePath)).mode & 0o777).toBe(0o600);
      await archive.dispose();
      await archive.dispose();
      await expect(stat(archivePath)).rejects.toThrow();
    } finally {
      await disposeArchive(archive);
    }
  });

  it("rejects invalid traversal, absolute, control, reserved, oversized, and duplicate paths", async () => {
    const invalidPaths = [
      "a/../b",
      "./a",
      "a/",
      "a//b",
      "/absolute",
      "a\\b",
      "a\nb",
      "NUL\u0000path",
      "NOTICE.txt",
      "manifest.json",
      "..",
      "C:/config",
      "C:config",
      `${"a/".repeat(600)}tail`,
    ];
    for (const path of invalidPaths) {
      await expect(build([source(path, [])])).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      build([source("transcripts/a.jsonl", []), source("transcripts/a.jsonl", [])]),
    ).rejects.toMatchObject({ code: "invalid" });

    const before = await tempExportDirs();
    await expect(build([source("transcripts/../secret.txt", [])])).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await tempExportDirs()).toEqual(before);
  });

  it("enforces source and archive and entry budgets incrementally", async () => {
    await expect(
      build([source("transcripts/large.jsonl", [new Uint8Array(6)])], {
        limits: { maxSourceBytes: 5 },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      build([source("transcripts/a.jsonl", [new Uint8Array(3), new Uint8Array(3)])], {
        limits: { maxSourceBytes: 5 },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(build([], { limits: { maxArchiveBytes: 1 } })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(build([], { limits: { maxEntries: 1 } })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      build([source("transcripts/a.jsonl", [])], {
        limits: { maxEntries: 2 },
      }),
    ).rejects.toMatchObject({ code: "invalid" });

    const before = await tempExportDirs();
    const emptyArchive = await build([], { limits: { maxEntries: 2 } });
    try {
      expect(WorkspaceExportManifestSchema.parse(emptyArchive.manifest).entries).toHaveLength(1);
      expect(Object.keys(await unzipArchive(emptyArchive.path))).toHaveLength(2);
    } finally {
      await disposeArchive(emptyArchive);
    }

    await expect(
      build([source("transcripts/a.jsonl", []), source("transcripts/b.jsonl", [])], {
        limits: { maxEntries: 3 },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    const singleArchive = await build([source("transcripts/a.jsonl", [])], {
      limits: { maxEntries: 3 },
    });
    try {
      expect(WorkspaceExportManifestSchema.parse(singleArchive.manifest).entries).toHaveLength(2);
      expect(Object.keys(await unzipArchive(singleArchive.path))).toHaveLength(3);
    } finally {
      await disposeArchive(singleArchive);
    }
    expect(await tempExportDirs()).toEqual(before);
  });

  it("aborts a hung source iterator and cleans up", async () => {
    const controller = new AbortController();
    const hung = (async function* () {
      await new Promise<void>(() => {});
      yield source("transcripts/never.jsonl", []);
    })();
    const before = await tempExportDirs();
    const pending = buildWorkspaceExportArchive({
      workspace,
      createdAt,
      entries: hung,
      signal: controller.signal,
      limits: { timeoutMs: 60_000 },
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(await tempExportDirs()).toEqual(before);
  });

  it("fails on deadline even when the source iterator never resolves and cleans up", async () => {
    const hung = (async function* () {
      await new Promise<void>(() => {});
      yield source("transcripts/never.jsonl", []);
    })();
    const before = await tempExportDirs();
    await expect(
      buildWorkspaceExportArchive({
        workspace,
        createdAt,
        entries: hung,
        limits: { timeoutMs: 40 },
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "Workspace export timed out." });
    expect(await tempExportDirs()).toEqual(before);
  });

  it("maps source and sink failures to safe public errors and cleans up", async () => {
    const throwing = (async function* () {
      yield source("transcripts/a.jsonl", []);
      throw new Error("private source failure");
    })();
    const before = await tempExportDirs();
    await expect(
      buildWorkspaceExportArchive({ workspace, createdAt, entries: throwing }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "Workspace export archive could not be built.",
    });
    expect(await tempExportDirs()).toEqual(before);

    const fakeHandle = {
      write: vi.fn().mockRejectedValue(new Error("private disk failure")),
      sync: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 999 }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileHandle;
    const openMock = vi.mocked(fsPromises.open);
    openMock.mockResolvedValueOnce(fakeHandle);
    await expect(build([source("transcripts/a.jsonl", [new Uint8Array(4)])])).rejects.toMatchObject(
      {
        code: "invalid",
        message: "Workspace export archive could not be built.",
      },
    );
    expect(fakeHandle.write).toHaveBeenCalled();
    expect(openMock).toHaveBeenCalled();
    expect(await tempExportDirs()).toEqual(before);
  });

  it("honors abort while the archive file is still being opened", async () => {
    const controller = new AbortController();
    const openMock = vi.mocked(fsPromises.open);
    openMock.mockReturnValueOnce(new Promise<never>(() => {}));
    const before = await tempExportDirs();
    const pending = buildWorkspaceExportArchive({
      workspace,
      createdAt,
      entries: (async function* () {})(),
      signal: controller.signal,
      limits: { timeoutMs: 60_000 },
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "conflict" });
    expect(await tempExportDirs()).toEqual(before);
  });

  it("rejects an oversized emitted ZIP chunk before writing it", async () => {
    vi.resetModules();
    vi.doMock("fflate", async (importOriginal) => {
      const actual = await importOriginal<typeof import("fflate")>();
      class OversizedZip {
        ondata: (err: FlateError | null, chunk: Uint8Array, final: boolean) => void;

        constructor(cb: (err: FlateError | null, chunk: Uint8Array, final: boolean) => void) {
          this.ondata = cb;
        }

        add(file: ZipInputFile): void {
          file.ondata = (err, chunk, final) => {
            if (err) this.ondata(err, new Uint8Array(), final);
            else this.ondata(null, chunk, final);
          };
        }

        end(): void {
          this.ondata(null, new Uint8Array(10_000), true);
        }
      }
      return { ...actual, Zip: OversizedZip as unknown as typeof actual.Zip };
    });
    const { buildWorkspaceExportArchive: buildMocked } = await import(
      "./workspace-export-archive.js"
    );
    const fakeHandle = {
      write: vi.fn().mockImplementation(async (chunk: Uint8Array) => ({
        bytesWritten: chunk.byteLength,
      })),
      sync: vi.fn().mockResolvedValue(undefined),
      stat: vi.fn().mockResolvedValue({ size: 999 }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as FileHandle;
    const openMock = vi.mocked(fsPromises.open);
    openMock.mockResolvedValueOnce(fakeHandle);
    const before = await tempExportDirs();
    await expect(
      buildMocked({
        workspace,
        createdAt,
        entries: (async function* () {})(),
        limits: { maxArchiveBytes: 8_192, maxEntries: 5_000 },
      }),
    ).rejects.toMatchObject({
      code: "invalid",
      message: "Workspace export archive size limit exceeded.",
    });
    expect(fakeHandle.write).toHaveBeenCalled();
    expect(await tempExportDirs()).toEqual(before);
  });

  it("returns a typed WorkspaceExportArchiveError for hard failures", async () => {
    try {
      await build([source("transcripts/../escape.txt", [])]);
      expect.unreachable("expected invalid path to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceExportArchiveError);
      expect((error as WorkspaceExportArchiveError).code).toBe("invalid");
      expect((error as WorkspaceExportArchiveError).message).not.toContain("escape.txt");
    }
  });
});
