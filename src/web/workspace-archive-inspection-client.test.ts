import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES } from "../shared/contracts.js";
import {
  WORKSPACE_ARCHIVE_INSPECTION_TIMEOUT_MS,
  type WorkspaceArchiveInspectionProgress,
  type WorkspaceArchiveInspectionReport,
} from "../shared/workspace-archive-inspection-contracts.js";
import {
  inspectArchiveInWorker,
  WorkspaceArchiveInspectionClientError,
} from "./workspace-archive-inspection-client.js";

interface FakeWorkerEvent {
  data: unknown;
}

type FakeWorkerListener = (event: FakeWorkerEvent) => void;

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly posts: unknown[] = [];
  terminations = 0;
  private readonly listeners = new Map<string, Set<FakeWorkerListener>>();

  constructor(_url: string | URL, _options?: unknown) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: FakeWorkerListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeWorkerListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeWorkerListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown): void {
    this.posts.push(message);
  }

  terminate(): void {
    this.terminations += 1;
  }

  emit(type: string, data: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ data });
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface InspectionRequestMessage {
  type: "inspect";
  requestId: number;
  file: File;
}

function zipFile(bytes = 3): File {
  return new File([new Uint8Array(bytes)], "workspace.zip", { type: "application/zip" });
}

function oversizedFile(): File {
  return {
    size: WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES + 1,
    name: "workspace.zip",
    type: "application/zip",
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    slice: () => new Blob(),
  } as unknown as File;
}

function inspectionReport(): WorkspaceArchiveInspectionReport {
  return {
    manifest: {
      format: "nexestra.workspace-export",
      version: 1,
      createdAt: "2026-09-09T00:00:00.000Z",
      workspace: { id: "workspace-a", name: "Workspace A" },
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
      entries: [
        {
          path: "state.json",
          kind: "metadata",
          bytes: 10,
          sha256: "a".repeat(64),
        },
      ],
    },
    archiveBytes: 10,
    payloadBytes: 3,
  };
}

function progressReply(
  requestId: number,
  progress: Partial<WorkspaceArchiveInspectionProgress> = {},
): { type: "progress"; requestId: number; progress: WorkspaceArchiveInspectionProgress } {
  return {
    type: "progress",
    requestId,
    progress: {
      phase: "reading",
      verifiedEntries: 1,
      totalEntries: 2,
      verifiedBytes: 3,
      totalBytes: 3,
      ...progress,
    },
  };
}

function resultReply(requestId: number): {
  type: "result";
  requestId: number;
  report: WorkspaceArchiveInspectionReport;
} {
  return { type: "result", requestId, report: inspectionReport() };
}

function requestFrom(worker: FakeWorker): InspectionRequestMessage {
  expect(worker.posts).toHaveLength(1);
  return worker.posts[0] as InspectionRequestMessage;
}

function workerAt(index: number): FakeWorker {
  const worker = FakeWorker.instances[index];
  if (worker === undefined) {
    throw new Error(`expected worker at index ${index}`);
  }
  return worker;
}

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("inspectArchiveInWorker lifecycle", () => {
  it("returns the report and forwards sane progress without network calls", async () => {
    const onProgress = vi.fn();
    const promise = inspectArchiveInWorker(zipFile(), { onProgress });
    const worker = workerAt(0);
    const request = requestFrom(worker);
    expect(request.type).toBe("inspect");
    expect(request.requestId).toBeGreaterThan(0);
    expect(request.file).toBeInstanceOf(File);

    const progress = progressReply(request.requestId);
    worker.emit("message", progress);
    worker.emit("message", resultReply(request.requestId));

    await expect(promise).resolves.toEqual(inspectionReport());
    expect(onProgress).toHaveBeenCalledWith(progress.progress);
    expect(worker.terminations).toBe(1);
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("messageerror")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("ignores stale request ids and lets a fresh call succeed", async () => {
    const first = inspectArchiveInWorker(zipFile());
    const firstWorker = workerAt(0);
    const firstRequest = requestFrom(firstWorker);
    firstWorker.emit("message", resultReply(firstRequest.requestId + 10));
    firstWorker.emit("message", {
      type: "unknown",
      requestId: firstRequest.requestId + 11,
      progress: { phase: "broken", verifiedEntries: -1 },
    });

    await Promise.resolve();
    expect(firstWorker.terminations).toBe(0);
    firstWorker.emit("message", resultReply(firstRequest.requestId));
    await expect(first).resolves.toEqual(inspectionReport());
    expect(firstWorker.terminations).toBe(1);

    const second = inspectArchiveInWorker(zipFile());
    const secondWorker = workerAt(1);
    const secondRequest = requestFrom(secondWorker);
    expect(secondRequest.requestId).toBeGreaterThan(firstRequest.requestId);
    secondWorker.emit("message", resultReply(secondRequest.requestId));
    await expect(second).resolves.toEqual(inspectionReport());
    expect(secondWorker.terminations).toBe(1);
  });

  it("terminates a worker that aborts reentrantly during construction", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    class ReentrantAbortWorker extends FakeWorker {
      constructor(url: string | URL, options?: unknown) {
        super(url, options);
        controller.abort();
      }
    }
    vi.stubGlobal("Worker", ReentrantAbortWorker as unknown as typeof Worker);

    const promise = inspectArchiveInWorker(zipFile(), { signal: controller.signal });
    const worker = workerAt(0);
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.posts).toHaveLength(0);
    expect(worker.terminations).toBe(1);
    expect(worker.listenerCount("message")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels and terminates even when the worker never replies", async () => {
    const controller = new AbortController();
    const promise = inspectArchiveInWorker(zipFile(), { signal: controller.signal });
    const worker = workerAt(0);
    const request = requestFrom(worker);

    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(worker.terminations).toBe(1);
    expect(worker.listenerCount("message")).toBe(0);

    worker.emit("message", resultReply(request.requestId));
    expect(worker.terminations).toBe(1);
  });

  it("times out with a limit error and terminates an unresponsive worker", async () => {
    vi.useFakeTimers();
    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    const assertion = expect(promise).rejects.toMatchObject({
      code: "limit",
      message: expect.stringContaining("timed out"),
    });

    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_INSPECTION_TIMEOUT_MS + 1);
    await assertion;
    expect(worker.terminations).toBe(1);
    expect(worker.listenerCount("message")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("creates no worker for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = inspectArchiveInWorker(zipFile(), { signal: controller.signal });
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("rejects oversized and empty files before creating a worker", async () => {
    await expect(inspectArchiveInWorker(oversizedFile())).rejects.toMatchObject({
      code: "limit",
    });
    await expect(inspectArchiveInWorker(new File([], "workspace.zip"))).rejects.toMatchObject({
      code: "invalid",
    });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("reports unsupported when Worker cannot be created", async () => {
    vi.useFakeTimers();
    class ThrowingWorker {
      constructor() {
        throw new Error("worker unavailable");
      }
    }
    vi.stubGlobal("Worker", ThrowingWorker as unknown as typeof Worker);

    await expect(inspectArchiveInWorker(zipFile())).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports unsupported when Worker is unavailable globally", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(inspectArchiveInWorker(zipFile())).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("settles with invalid and terminates once when postMessage throws", async () => {
    vi.useFakeTimers();
    class ThrowingPostWorker extends FakeWorker {
      override postMessage(_message: unknown): void {
        throw new Error("not cloneable");
      }
    }
    vi.stubGlobal("Worker", ThrowingPostWorker as unknown as typeof Worker);

    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    await expect(promise).rejects.toMatchObject({
      code: "invalid",
      message: "Workspace archive could not be sent to the inspector worker.",
    });
    expect(worker.terminations).toBe(1);
    expect(worker.listenerCount("message")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles with invalid on a messageerror event", async () => {
    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    worker.emit("messageerror", {});
    await expect(promise).rejects.toMatchObject({
      code: "invalid",
      message: "Workspace inspector message could not be decoded.",
    });
    expect(worker.terminations).toBe(1);
  });

  it("settles with unsupported on a worker error event", async () => {
    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    worker.emit("error", { message: "worker crashed" });
    await expect(promise).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(worker.terminations).toBe(1);
  });

  it("rejects a malformed reply as an invalid protocol response", async () => {
    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    requestFrom(worker);
    worker.emit("message", null);
    await expect(promise).rejects.toMatchObject({ code: "invalid" });
    expect(worker.terminations).toBe(1);
  });

  it("rejects an unknown reply type as an invalid protocol response", async () => {
    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    const request = requestFrom(worker);
    worker.emit("message", { type: "unknown", requestId: request.requestId });
    await expect(promise).rejects.toMatchObject({ code: "invalid" });
    expect(worker.terminations).toBe(1);
  });

  it("rejects regressing same-phase progress as an invalid protocol response", async () => {
    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    const request = requestFrom(worker);
    worker.emit("message", progressReply(request.requestId, { verifiedEntries: 5 }));
    worker.emit("message", progressReply(request.requestId, { verifiedEntries: 2 }));
    await expect(promise).rejects.toMatchObject({ code: "invalid" });
    expect(worker.terminations).toBe(1);
  });

  it("exposes a structural client error with code and optional path", async () => {
    const promise = inspectArchiveInWorker(zipFile());
    const worker = workerAt(0);
    const request = requestFrom(worker);
    worker.emit("message", {
      type: "error",
      requestId: request.requestId,
      error: { code: "invalid", message: "bad zip", path: "state.json" },
    });
    await expect(promise).rejects.toMatchObject({
      code: "invalid",
      message: "bad zip",
      path: "state.json",
    });
    await expect(promise).rejects.toBeInstanceOf(WorkspaceArchiveInspectionClientError);
    expect(worker.terminations).toBe(1);
  });
});
