import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES } from "../shared/contracts.js";
import {
  WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS,
  type WorkspaceArchiveInspectionProgress,
  type WorkspaceArchiveInspectionReport,
} from "../shared/workspace-archive-inspection-contracts.js";

const engine = vi.hoisted(() => {
  class WorkspaceArchiveInspectionError extends Error {
    readonly code: "invalid" | "unsupported" | "limit" | "cancelled";
    readonly path?: string;

    constructor(
      code: "invalid" | "unsupported" | "limit" | "cancelled",
      message: string,
      path?: string,
    ) {
      super(message);
      this.name = "WorkspaceArchiveInspectionError";
      this.code = code;
      if (path !== undefined) {
        this.path = path;
      }
    }
  }
  return {
    inspectWorkspaceArchive: vi.fn(),
    WorkspaceArchiveInspectionError,
  };
});

vi.mock("../shared/workspace-archive-inspection.js", () => engine);

interface WorkerScopeLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: (message: unknown) => void;
}

let workerScope: WorkerScopeLike;
let posted: unknown[];

function report(): WorkspaceArchiveInspectionReport {
  return {
    manifest: {
      format: "nexestra.workspace-export",
      version: 1,
      createdAt: "2026-09-09T00:00:00.000Z",
      workspace: { id: "workspace-a", name: "Workspace A" },
      stateVersion: 7,
      redaction: "known-credentials",
      importSupported: false,
      excluded: ["credentials"],
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

function progress(): WorkspaceArchiveInspectionProgress {
  return {
    phase: "reading",
    verifiedEntries: 1,
    totalEntries: 1,
    verifiedBytes: 3,
    totalBytes: 3,
  };
}

function receive(data: unknown): void {
  workerScope.onmessage?.({ data });
}

beforeEach(async () => {
  posted = [];
  engine.inspectWorkspaceArchive.mockReset();
  vi.resetModules();
  vi.stubGlobal("postMessage", (message: unknown): void => {
    posted.push(message);
  });
  await import("./workspace-archive-inspection-worker.js");
  workerScope = globalThis as unknown as WorkerScopeLike;
});

afterEach(() => {
  workerScope.onmessage = null;
  vi.unstubAllGlobals();
});

describe("workspace archive inspection worker handler", () => {
  it("forwards progress and a result for one valid request", async () => {
    const file = new File([new Uint8Array(3)], "workspace.zip");
    const requestId = 7;
    engine.inspectWorkspaceArchive.mockResolvedValue(report());

    receive({ type: "inspect", requestId, file });
    await vi.waitFor(() => {
      expect(engine.inspectWorkspaceArchive).toHaveBeenCalledTimes(1);
    });

    const options = engine.inspectWorkspaceArchive.mock.calls[0]?.[1] as {
      signal: AbortSignal;
      onProgress: (value: WorkspaceArchiveInspectionProgress) => void;
    };
    expect(engine.inspectWorkspaceArchive.mock.calls[0]?.[0]).toBe(file);
    expect(options).toBeDefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    options.onProgress(progress());

    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: "progress",
        requestId,
        progress: progress(),
      });
    });
    await vi.waitFor(() => {
      expect(posted).toContainEqual({ type: "result", requestId, report: report() });
    });
  });

  it("posts a bounded invalid error for malformed request shapes", () => {
    const invalidRequests = [
      null,
      { type: "other", requestId: 1, file: new File([], "x") },
      { type: "inspect", requestId: 0, file: new File([], "x") },
      { type: "inspect", requestId: 1, file: { size: 1 } },
      {
        type: "inspect",
        requestId: 1,
        file: {
          size: Number.NaN,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          slice: () => new Blob(),
        },
      },
    ];
    for (const data of invalidRequests) {
      posted = [];
      receive(data);
      expect(engine.inspectWorkspaceArchive).not.toHaveBeenCalled();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        type: "error",
        requestId: 1,
        error: {
          code: "invalid",
          message: "Workspace inspector received an invalid request.",
        },
      });
    }
  });

  it("rejects an oversized file without calling the engine", () => {
    const oversized = new File([new Uint8Array(1)], "workspace.zip");
    Object.defineProperty(oversized, "size", { value: WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES + 1 });
    receive({ type: "inspect", requestId: 2, file: oversized });
    expect(posted[0]).toMatchObject({
      error: { code: "limit", message: "Workspace archive is too large to inspect." },
    });
    expect(engine.inspectWorkspaceArchive).not.toHaveBeenCalled();
  });

  it("rejects an empty file without calling the engine", () => {
    receive({ type: "inspect", requestId: 3, file: new File([], "workspace.zip") });
    expect(posted[0]).toMatchObject({
      error: { code: "invalid", message: "Workspace archive is empty." },
    });
    expect(engine.inspectWorkspaceArchive).not.toHaveBeenCalled();
  });

  it("forwards typed engine errors with bounded message and path", async () => {
    const requestId = 9;
    engine.inspectWorkspaceArchive.mockRejectedValue(
      new engine.WorkspaceArchiveInspectionError("invalid", "bad zip", "nested/state.json"),
    );
    receive({ type: "inspect", requestId, file: new File([new Uint8Array(1)], "workspace.zip") });
    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: "error",
        requestId,
        error: {
          code: "invalid",
          message: "bad zip",
          path: "nested/state.json",
        },
      });
    });
  });

  it("maps unknown engine failures to a bounded invalid error", async () => {
    engine.inspectWorkspaceArchive.mockRejectedValue(new Error("boom"));
    receive({
      type: "inspect",
      requestId: 4,
      file: new File([new Uint8Array(1)], "workspace.zip"),
    });
    await vi.waitFor(() => {
      expect(posted).toContainEqual({
        type: "error",
        requestId: 4,
        error: { code: "invalid", message: "Workspace archive inspection failed." },
      });
    });
  });

  it("ignores later requests after the first is handled", async () => {
    engine.inspectWorkspaceArchive.mockResolvedValue(report());
    receive({
      type: "inspect",
      requestId: 1,
      file: new File([new Uint8Array(1)], "workspace.zip"),
    });
    receive({
      type: "inspect",
      requestId: 2,
      file: new File([new Uint8Array(1)], "workspace.zip"),
    });
    await vi.waitFor(() => {
      expect(engine.inspectWorkspaceArchive).toHaveBeenCalledTimes(1);
    });
    expect(posted).toContainEqual({
      type: "error",
      requestId: 2,
      error: { code: "invalid", message: "Workspace inspector only handles one request." },
    });
  });

  it("arms the engine signal with the core timeout", async () => {
    vi.useFakeTimers();
    engine.inspectWorkspaceArchive.mockReturnValue(new Promise(() => undefined));
    receive({
      type: "inspect",
      requestId: 5,
      file: new File([new Uint8Array(1)], "workspace.zip"),
    });
    await vi.waitFor(() => {
      expect(engine.inspectWorkspaceArchive).toHaveBeenCalledTimes(1);
    });
    const options = engine.inspectWorkspaceArchive.mock.calls[0]?.[1] as {
      signal: AbortSignal;
    };
    expect(options.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS + 1);
    expect(options.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
