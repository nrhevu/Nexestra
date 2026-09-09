import { WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES } from "../shared/contracts.js";
import {
  WORKSPACE_ARCHIVE_INSPECTION_TIMEOUT_MS,
  type WorkspaceArchiveInspectionFailure,
  type WorkspaceArchiveInspectionProgress,
  WorkspaceArchiveInspectionReplySchema,
  type WorkspaceArchiveInspectionReport,
  type WorkspaceArchiveInspectionRequest,
} from "../shared/workspace-archive-inspection-contracts.js";

export type WorkspaceArchiveInspectionClientErrorCode = WorkspaceArchiveInspectionFailure["code"];

/**
 * Structural error returned by the client. The shared engine error class is
 * intentionally not imported here so the engine stays inside the Worker
 * bundle.
 */
export class WorkspaceArchiveInspectionClientError extends Error {
  readonly code: WorkspaceArchiveInspectionClientErrorCode;
  readonly path?: string;

  constructor(code: WorkspaceArchiveInspectionClientErrorCode, message: string, path?: string) {
    super(message);
    this.name = "WorkspaceArchiveInspectionClientError";
    this.code = code;
    if (path !== undefined) {
      this.path = path;
    }
  }
}

export interface WorkspaceArchiveInspectionClientOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceArchiveInspectionProgress) => void;
}

let nextRequestId = 1;

function nextInspectionRequestId(): number {
  const requestId = nextRequestId;
  if (nextRequestId >= Number.MAX_SAFE_INTEGER) {
    nextRequestId = 1;
  } else {
    nextRequestId += 1;
  }
  return requestId;
}

function readReplyRequestId(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const requestId = (value as { requestId?: unknown }).requestId;
  if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId <= 0) {
    return undefined;
  }
  return requestId;
}

function progressIsSane(
  progress: WorkspaceArchiveInspectionProgress,
  lastVerifiedByPhase: Map<
    WorkspaceArchiveInspectionProgress["phase"],
    { entries: number; bytes: number }
  >,
): boolean {
  if (
    progress.verifiedEntries > progress.totalEntries ||
    progress.verifiedBytes > progress.totalBytes
  ) {
    return false;
  }
  const previous = lastVerifiedByPhase.get(progress.phase);
  if (
    previous !== undefined &&
    (progress.verifiedEntries < previous.entries || progress.verifiedBytes < previous.bytes)
  ) {
    return false;
  }
  lastVerifiedByPhase.set(progress.phase, {
    entries: progress.verifiedEntries,
    bytes: progress.verifiedBytes,
  });
  return true;
}

/**
 * Inspects a local workspace export ZIP in a dedicated Worker. The Worker is
 * created and terminated per call; the File is cloned with postMessage and is
 * never read or uploaded on the main thread.
 */
export async function inspectArchiveInWorker(
  file: File,
  options?: WorkspaceArchiveInspectionClientOptions,
): Promise<WorkspaceArchiveInspectionReport> {
  if (options?.signal?.aborted) {
    throw new WorkspaceArchiveInspectionClientError(
      "cancelled",
      "Workspace archive inspection was cancelled.",
    );
  }
  if (file.size > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) {
    throw new WorkspaceArchiveInspectionClientError(
      "limit",
      "Workspace archive is too large to inspect.",
    );
  }
  if (file.size <= 0) {
    throw new WorkspaceArchiveInspectionClientError("invalid", "Workspace archive is empty.");
  }
  if (typeof Worker !== "function") {
    throw new WorkspaceArchiveInspectionClientError(
      "unsupported",
      "Workspace archive inspection is not supported in this browser.",
    );
  }

  return new Promise<WorkspaceArchiveInspectionReport>((resolve, reject) => {
    const requestId = nextInspectionRequestId();
    const signal = options?.signal;
    const onProgress = options?.onProgress;
    let worker: Worker | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const lastVerifiedByPhase = new Map<
      WorkspaceArchiveInspectionProgress["phase"],
      { entries: number; bytes: number }
    >();

    function settle(then: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      signal?.removeEventListener("abort", onAbort);
      if (worker !== undefined) {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("messageerror", onMessageError);
        worker.removeEventListener("error", onWorkerError);
        worker.terminate();
        worker = undefined;
      }
      then();
    }

    function rejectWith(
      code: WorkspaceArchiveInspectionClientErrorCode,
      message: string,
      path?: string,
    ): void {
      settle(() => reject(new WorkspaceArchiveInspectionClientError(code, message, path)));
    }

    function onAbort(): void {
      rejectWith("cancelled", "Workspace archive inspection was cancelled.");
    }

    function onMessage(event: MessageEvent<unknown>): void {
      if (settled) {
        return;
      }
      const rawRequestId = readReplyRequestId(event.data);
      if (rawRequestId !== undefined && rawRequestId !== requestId) {
        return;
      }
      const parsed = WorkspaceArchiveInspectionReplySchema.safeParse(event.data);
      if (!parsed.success) {
        rejectWith("invalid", "Workspace inspector returned an invalid response.");
        return;
      }
      const reply = parsed.data;
      if (reply.requestId !== requestId) {
        return;
      }
      if (reply.type === "progress") {
        if (!progressIsSane(reply.progress, lastVerifiedByPhase)) {
          rejectWith("invalid", "Workspace inspector returned invalid progress.");
          return;
        }
        try {
          onProgress?.(reply.progress);
        } catch {
          // Observer callbacks must not break inspection or the Worker lifecycle.
        }
        return;
      }
      if (reply.type === "result") {
        settle(() => resolve(reply.report));
        return;
      }
      settle(() =>
        reject(
          new WorkspaceArchiveInspectionClientError(
            reply.error.code,
            reply.error.message,
            reply.error.path,
          ),
        ),
      );
    }

    function onMessageError(): void {
      rejectWith("invalid", "Workspace inspector message could not be decoded.");
    }

    function onWorkerError(): void {
      rejectWith("unsupported", "Workspace inspector worker failed before responding.");
    }

    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      worker = new Worker(new URL("./workspace-archive-inspection-worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      rejectWith("unsupported", "Workspace archive inspection is not supported in this browser.");
      return;
    }
    if (settled) {
      worker.terminate();
      worker = undefined;
      return;
    }

    worker.addEventListener("message", onMessage);
    worker.addEventListener("messageerror", onMessageError);
    worker.addEventListener("error", onWorkerError);
    timeoutId = setTimeout(() => {
      rejectWith(
        "limit",
        "Workspace archive inspection timed out while reading and verifying the archive.",
      );
    }, WORKSPACE_ARCHIVE_INSPECTION_TIMEOUT_MS);

    const request: WorkspaceArchiveInspectionRequest = {
      type: "inspect",
      requestId,
      file,
    };
    try {
      worker.postMessage(request);
    } catch {
      rejectWith("invalid", "Workspace archive could not be sent to the inspector worker.");
    }
  });
}
