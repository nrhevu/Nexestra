import { Check, Download, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES, type Workspace } from "../shared/contracts.js";
import "./WorkspaceExportDialog.css";

export interface WorkspaceExportDialogProps {
  workspace: Pick<Workspace, "id" | "name">;
  onClose: () => void;
}

export type WorkspaceExportPhase = "idle" | "busy" | "error" | "success";

export const WORKSPACE_EXPORT_UI_DEADLINE_MS = 45_000;
export const OBJECT_URL_CLEANUP_DELAY_MS = 5_000;

const EXPORT_FALLBACK_FILENAME = "nexestra-export.zip";

class ExportDeadlineError extends Error {
  readonly name = "ExportDeadlineError";

  constructor() {
    super("Export timed out after 45 seconds. The server took too long to prepare the archive.");
  }
}

function formatBytes(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return Number.isInteger(mebibytes) ? `${mebibytes} MiB` : `${bytes} bytes`;
}

function isZipContentType(value: string): boolean {
  return value.trim().toLowerCase().split(";")[0] === "application/zip";
}

function parseDispositionFilename(disposition: string): string | null {
  for (const part of disposition.split(";")) {
    const match = /^\s*filename\s*=\s*"?([^"]*)"?\s*$/i.exec(part);
    if (match && match[1]?.trim() !== "") return match[1]?.trim() ?? null;
  }
  return null;
}

export function safeExportFilename(
  disposition: string | null,
  fallback = EXPORT_FALLBACK_FILENAME,
): string {
  const raw = disposition === null ? null : parseDispositionFilename(disposition);
  if (raw === null) return fallback;
  const cleaned = raw.trim();
  if (/^[A-Za-z0-9._-]{1,200}$/.test(cleaned) && cleaned !== "." && cleaned !== "..") {
    return cleaned;
  }
  return fallback;
}

async function readExportErrorMessage(response: Response): Promise<string> {
  let message = "";
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") {
      const candidate = body.error.message.trim();
      if (candidate !== "") message = candidate;
    }
  } catch {
    // Non-JSON failure body; the HTTP fallback below is used instead.
  }
  return message === "" ? `Export failed (HTTP ${response.status}).` : message;
}

export async function readCappedBlob(
  body: ReadableStream<Uint8Array> | null,
  blobFallback: () => Promise<Blob>,
  maxBytes: number,
  deadline: Promise<never>,
  mediaType: string,
): Promise<Blob> {
  if (body == null) {
    // No stream is exposed, so the whole entity must be buffered before its
    // size can be checked. The caller rejects an oversized blob afterward;
    // that is the remaining trust boundary when Content-Length is absent or
    // understates the body.
    return blobFallback();
  }
  const reader = body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), deadline]);
      } catch (caught) {
        await reader.cancel().catch(() => {});
        throw caught;
      }
      if (result.done) break;
      if (result.value.byteLength === 0) continue;
      const nextTotal = total + result.value.byteLength;
      if (nextTotal > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`The export is larger than ${formatBytes(maxBytes)}.`);
      }
      const chunk = result.value;
      chunks.push(
        chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
          ? (chunk.buffer as ArrayBuffer)
          : chunk.slice().buffer,
      );
      total = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, { type: mediaType });
}

export function WorkspaceExportDialog({ workspace, onClose }: WorkspaceExportDialogProps) {
  const [phase, setPhase] = useState<WorkspaceExportPhase>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestIdRef = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const deadlineIdRef = useRef<number | null>(null);
  const deadlineFiredRef = useRef(false);
  const currentWorkspaceRef = useRef(workspace);
  const lastWorkspaceIdRef = useRef(workspace.id);
  const objectUrlRef = useRef<string | null>(null);
  const objectUrlTimerRef = useRef<number | null>(null);
  if (currentWorkspaceRef.current.id !== workspace.id) {
    currentWorkspaceRef.current = workspace;
  }

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlTimerRef.current !== null) {
      window.clearTimeout(objectUrlTimerRef.current);
      objectUrlTimerRef.current = null;
    }
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const discardPending = useCallback(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (deadlineIdRef.current !== null) {
      window.clearTimeout(deadlineIdRef.current);
      deadlineIdRef.current = null;
    }
    deadlineFiredRef.current = false;
    busyRef.current = false;
  }, []);

  // A late response or blob must never be used for another workspace, even
  // before the workspace-change effect below has run.
  useEffect(() => {
    if (lastWorkspaceIdRef.current === workspace.id) return;
    lastWorkspaceIdRef.current = workspace.id;
    discardPending();
    setPhase("idle");
    setErrorMessage("");
  }, [discardPending, workspace.id]);

  useEffect(
    () => () => {
      discardPending();
      revokeObjectUrl();
    },
    [discardPending, revokeObjectUrl],
  );

  useEffect(() => {
    const previousActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryRef.current?.focus();
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousActive?.focus();
    };
  }, []);

  const triggerDownload = useCallback(
    (blob: Blob, filename: string) => {
      revokeObjectUrl();
      const objectUrl = URL.createObjectURL(blob);
      objectUrlRef.current = objectUrl;
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      objectUrlTimerRef.current = window.setTimeout(() => {
        if (objectUrlRef.current === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrlRef.current = null;
        }
        objectUrlTimerRef.current = null;
      }, OBJECT_URL_CLEANUP_DELAY_MS);
    },
    [revokeObjectUrl],
  );

  const startDownload = useCallback(async () => {
    if (busyRef.current) return;
    const captured = { id: workspace.id, name: workspace.name };
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    busyRef.current = true;
    deadlineFiredRef.current = false;
    setPhase("busy");
    setErrorMessage("");
    const deadline = new Promise<never>((_, reject) => {
      const id = window.setTimeout(() => {
        deadlineFiredRef.current = true;
        controller.abort();
        reject(new ExportDeadlineError());
      }, WORKSPACE_EXPORT_UI_DEADLINE_MS);
      deadlineIdRef.current = id;
    });
    const deadlineId = deadlineIdRef.current;
    try {
      const response = await Promise.race([
        fetch(`/api/workspaces/${encodeURIComponent(captured.id)}/export`, {
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (requestId !== requestIdRef.current || captured.id !== currentWorkspaceRef.current.id) {
        return;
      }
      if (!response.ok) {
        throw new Error(await Promise.race([readExportErrorMessage(response), deadline]));
      }
      const contentType = response.headers.get("content-type");
      if (contentType === null || !isZipContentType(contentType)) {
        throw new Error("The export response was not a ZIP archive.");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const parsedLength = /^\d+$/.test(contentLength) ? Number(contentLength) : Number.NaN;
        if (!Number.isSafeInteger(parsedLength)) {
          throw new Error("The server returned an invalid export size.");
        }
        if (parsedLength > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) {
          throw new Error(
            `The export is larger than ${formatBytes(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES)}.`,
          );
        }
      }
      const blob = await Promise.race([
        readCappedBlob(
          response.body,
          () => response.blob(),
          WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
          deadline,
          "application/zip",
        ),
        deadline,
      ]);
      if (requestId !== requestIdRef.current || captured.id !== currentWorkspaceRef.current.id) {
        return;
      }
      if (blob.size > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) {
        throw new Error(
          `The export is larger than ${formatBytes(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES)}.`,
        );
      }
      if (blob.type !== "" && !isZipContentType(blob.type)) {
        throw new Error("The export response was not a ZIP archive.");
      }
      triggerDownload(blob, safeExportFilename(response.headers.get("content-disposition")));
      setPhase("success");
    } catch (caught) {
      if (requestId !== requestIdRef.current || captured.id !== currentWorkspaceRef.current.id) {
        return;
      }
      if (deadlineFiredRef.current) {
        setErrorMessage(new ExportDeadlineError().message);
      } else if (caught instanceof Error && caught.message !== "") {
        setErrorMessage(caught.message);
      } else {
        setErrorMessage("Export failed. Please try again.");
      }
      setPhase("error");
    } finally {
      if (requestId === requestIdRef.current) {
        busyRef.current = false;
        if (controllerRef.current === controller) controllerRef.current = null;
        if (deadlineId !== null && deadlineIdRef.current === deadlineId) {
          window.clearTimeout(deadlineId);
          deadlineIdRef.current = null;
        }
      }
    }
  }, [triggerDownload, workspace.id, workspace.name]);

  const handleDownload = () => {
    void startDownload();
  };

  const handleCancel = () => {
    if (!busyRef.current) return;
    discardPending();
    setPhase("idle");
    setErrorMessage("");
  };

  const busy = phase === "busy";
  const disabled = busy || phase === "success";

  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="modal workspace-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">WORKSPACE</p>
            <h2 id={titleId}>Export workspace</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body workspace-export-body">
          <p className="workspace-export-description">
            The ZIP contains workspace metadata, all conversations, uploaded files, and every
            document version, with a SHA-256 manifest. Repository files, harness authentication, and
            browser drafts are excluded. Known credentials are redacted from messages, and an upload
            that still contains them blocks the export. This archive is portable only; importing or
            restoring it is not available.
          </p>
          <p className="workspace-export-scope">
            Workspace: <strong>{workspace.name}</strong>
          </p>
          {busy && (
            <p className="workspace-export-status" role="status">
              <LoaderCircle className="spin" size={15} />
              Preparing export…
            </p>
          )}
          {phase === "error" && (
            <div className="form-error workspace-export-error" role="alert">
              <span>{errorMessage}</span>
              <button type="button" className="secondary-button" onClick={handleDownload}>
                Retry
              </button>
            </div>
          )}
          {phase === "success" && (
            <p className="workspace-export-status workspace-export-success" role="status">
              <Check size={15} />
              Download started.
            </p>
          )}
        </div>
        <div className="modal-actions workspace-export-actions">
          {busy && (
            <button type="button" className="secondary-button" onClick={handleCancel}>
              Cancel export
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className="primary-button"
            disabled={disabled}
            onClick={handleDownload}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            {busy ? "Preparing export…" : "Download ZIP"}
          </button>
        </div>
      </section>
    </div>
  );
}
