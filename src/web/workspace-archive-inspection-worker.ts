import { WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES } from "../shared/contracts.js";
import {
  inspectWorkspaceArchive,
  WorkspaceArchiveInspectionError,
} from "../shared/workspace-archive-inspection.js";
import type {
  WorkspaceArchiveInspectionFailure,
  WorkspaceArchiveInspectionProgress,
  WorkspaceArchiveInspectionReport,
} from "../shared/workspace-archive-inspection-contracts.js";

// The project intentionally compiles with DOM (not WebWorker) libs, so this
// module describes only the narrow worker surface it uses on globalThis.
interface WorkerMessageEventLike {
  data: unknown;
}

interface WorkerScopeLike {
  postMessage(message: unknown): void;
  onmessage: ((event: WorkerMessageEventLike) => void) | null;
}

const workerScope = globalThis as unknown as WorkerScopeLike;

interface BlobLike {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isBlobLike(value: unknown): value is BlobLike {
  const size = (value as { size?: unknown })?.size;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof size === "number" &&
    Number.isFinite(size) &&
    size >= 0 &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof (value as { slice?: unknown }).slice === "function"
  );
}

function boundedMessage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    return "Workspace archive inspection failed.";
  }
  return value.slice(0, 500);
}

function boundedPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value.slice(0, 1_024);
}

function postError(
  requestId: number,
  code: WorkspaceArchiveInspectionFailure["code"],
  message: string,
  path?: string,
): void {
  const error: WorkspaceArchiveInspectionFailure = {
    code,
    message: boundedMessage(message),
  };
  if (path !== undefined) {
    const bounded = boundedPath(path);
    if (bounded !== undefined) {
      error.path = bounded;
    }
  }
  workerScope.postMessage({ type: "error", requestId, error });
}

function failureFromEngine(error: unknown): WorkspaceArchiveInspectionFailure {
  if (error instanceof WorkspaceArchiveInspectionError) {
    return {
      code: error.code,
      message: boundedMessage(error.message),
      ...(error.path !== undefined ? { path: boundedPath(error.path) } : {}),
    };
  }
  return {
    code: "invalid",
    message: "Workspace archive inspection failed.",
  };
}

interface InspectionRequest {
  type: "inspect";
  requestId: number;
  file: BlobLike;
}

function parseInspectionRequest(value: unknown): InspectionRequest | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "inspect") {
    return undefined;
  }
  if (!Number.isSafeInteger(record.requestId) || (record.requestId as number) <= 0) {
    return undefined;
  }
  if (!isBlobLike(record.file)) {
    return undefined;
  }
  return {
    type: "inspect",
    requestId: record.requestId as number,
    file: record.file,
  };
}

let handledRequest = false;

function isValidRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

workerScope.onmessage = (event): void => {
  const request = parseInspectionRequest(event.data);
  if (request === undefined) {
    const record = event.data as Record<string, unknown> | null | undefined;
    const requestId = isValidRequestId(record?.requestId) ? record.requestId : 1;
    postError(requestId, "invalid", "Workspace inspector received an invalid request.");
    return;
  }
  if (handledRequest) {
    postError(request.requestId, "invalid", "Workspace inspector only handles one request.");
    return;
  }
  handledRequest = true;

  if (request.file.size > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) {
    postError(request.requestId, "limit", "Workspace archive is too large to inspect.");
    return;
  }
  if (request.file.size <= 0) {
    postError(request.requestId, "invalid", "Workspace archive is empty.");
    return;
  }

  const file = request.file as unknown as Blob;
  const reportProgress = (progress: WorkspaceArchiveInspectionProgress): void => {
    workerScope.postMessage({ type: "progress", requestId: request.requestId, progress });
  };

  void (async (): Promise<void> => {
    try {
      const report: WorkspaceArchiveInspectionReport = await inspectWorkspaceArchive(file, {
        onProgress: reportProgress,
      });
      workerScope.postMessage({ type: "result", requestId: request.requestId, report });
    } catch (error) {
      const failure = failureFromEngine(error);
      postError(request.requestId, failure.code, failure.message, failure.path);
    }
  })();
};
