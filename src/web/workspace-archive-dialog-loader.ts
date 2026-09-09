import {
  WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS,
  type WorkspaceArchiveDialogComponent,
  type WorkspaceArchiveDialogKind,
} from "./workspace-archive-dialog-contracts.js";

export type WorkspaceArchiveDialogLoadErrorReason = "load" | "timeout";

export class WorkspaceArchiveDialogLoadError extends Error {
  readonly reason: WorkspaceArchiveDialogLoadErrorReason;

  constructor(reason: WorkspaceArchiveDialogLoadErrorReason) {
    super(
      reason === "timeout"
        ? "The archive dialog took too long to load."
        : "The archive dialog could not be loaded.",
    );
    this.name = "WorkspaceArchiveDialogLoadError";
    this.reason = reason;
  }
}

interface DialogLoadState {
  component?: WorkspaceArchiveDialogComponent;
  promise?: Promise<WorkspaceArchiveDialogComponent>;
  attemptId: number;
}

const loadStateByKind: Record<WorkspaceArchiveDialogKind, DialogLoadState> = {
  export: { attemptId: 0 },
  inspection: { attemptId: 0 },
};

function toLoadError(error: unknown): WorkspaceArchiveDialogLoadError {
  if (error instanceof WorkspaceArchiveDialogLoadError) {
    return error;
  }
  return new WorkspaceArchiveDialogLoadError("load");
}

async function importDialogComponent(
  kind: WorkspaceArchiveDialogKind,
): Promise<WorkspaceArchiveDialogComponent> {
  const module = (kind === "export"
    ? await import("./WorkspaceExportDialog.js")
    : await import("./WorkspaceArchiveInspectionDialog.js")) as unknown as Record<string, unknown>;
  const component =
    module[kind === "export" ? "WorkspaceExportDialog" : "WorkspaceArchiveInspectionDialog"];
  if (typeof component !== "function") {
    throw new WorkspaceArchiveDialogLoadError("load");
  }
  return component as WorkspaceArchiveDialogComponent;
}

/**
 * Loads an archive dialog module on first use and caches the ready component
 * per kind. Each kind has at most one tracked in-flight attempt; failed and
 * timed-out attempts are forgotten so an explicit retry can start a fresh one.
 * Dynamic imports cannot be aborted, so a timed-out module may still finish in
 * the background but can never update a later attempt.
 */
export function loadWorkspaceArchiveDialog(
  kind: WorkspaceArchiveDialogKind,
): Promise<WorkspaceArchiveDialogComponent> {
  const state = loadStateByKind[kind];
  if (state.component !== undefined) {
    return Promise.resolve(state.component);
  }
  if (state.promise !== undefined) {
    return state.promise;
  }

  const attemptId = state.attemptId + 1;
  state.attemptId = attemptId;
  let expired = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      expired = true;
      reject(new WorkspaceArchiveDialogLoadError("timeout"));
    }, WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS);
  });

  const importPromise = importDialogComponent(kind).then(
    (component) => {
      if (!expired && state.attemptId === attemptId) {
        state.component = component;
        if (state.promise === promise) {
          state.promise = undefined;
        }
      }
      return component;
    },
    (error: unknown) => {
      throw toLoadError(error);
    },
  );

  const promise = Promise.race([importPromise, timeoutPromise]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  });
  state.promise = promise;
  promise.catch(() => {
    if (state.promise === promise && state.attemptId === attemptId) {
      state.promise = undefined;
    }
  });
  return promise;
}
