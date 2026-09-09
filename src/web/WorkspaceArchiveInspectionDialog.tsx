import { Check, FileArchive, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES } from "../shared/contracts.js";
import {
  WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE,
  type WorkspaceArchiveInspectionProgress,
  type WorkspaceArchiveInspectionReport,
} from "../shared/workspace-archive-inspection-contracts.js";
import { inspectArchiveInWorker } from "./workspace-archive-inspection-client.js";
import "./WorkspaceArchiveInspectionDialog.css";

export interface WorkspaceArchiveInspectionDialogProps {
  onClose: () => void;
}

export type WorkspaceArchiveInspectionPhase = "idle" | "busy" | "error" | "success";

export interface WorkspaceArchiveInspectionError {
  message: string;
  path?: string;
}

interface InspectionFailureLike {
  code?: unknown;
  message?: unknown;
  path?: unknown;
}

const EMPTY_FILE_MESSAGE = "The selected file is empty.";
const FALLBACK_ERROR_MESSAGE = "The ZIP could not be inspected.";
const CANCELLED_ERROR_MESSAGE = "The check was cancelled. Try again.";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 bytes";
  const mebibytes = bytes / (1024 * 1024);
  if (Number.isInteger(mebibytes)) return `${mebibytes} MiB`;
  if (mebibytes >= 1) {
    const rounded = Number(mebibytes.toFixed(1));
    if (rounded < 1024) return `${rounded} MiB`;
  }
  return `${bytes.toLocaleString()} bytes`;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatExportDate(createdAt: string): string {
  return new Date(createdAt).toLocaleString();
}

function progressLabel(progress: WorkspaceArchiveInspectionProgress | null): string {
  if (progress === null || progress.phase === "reading") {
    return "Reading archive…";
  }
  const { verifiedBytes, totalBytes, verifiedEntries, totalEntries } = progress;
  const entries =
    totalEntries > 0
      ? `${formatCount(verifiedEntries)} of ${formatCount(totalEntries)} files`
      : `${formatCount(verifiedEntries)} files`;
  const bytes =
    totalBytes > 0 ? ` · ${formatBytes(verifiedBytes)} of ${formatBytes(totalBytes)}` : "";
  return `Verifying ${entries}${bytes}…`;
}

export function WorkspaceArchiveInspectionDialog({
  onClose,
}: WorkspaceArchiveInspectionDialogProps) {
  const [phase, setPhase] = useState<WorkspaceArchiveInspectionPhase>("idle");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<WorkspaceArchiveInspectionProgress | null>(null);
  const [report, setReport] = useState<WorkspaceArchiveInspectionReport | null>(null);
  const [error, setError] = useState<WorkspaceArchiveInspectionError | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestIdRef = useRef(0);
  const busyRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const discardPending = useCallback(() => {
    requestIdRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    busyRef.current = false;
  }, []);

  useEffect(
    () => () => {
      discardPending();
    },
    [discardPending],
  );

  useEffect(() => {
    const previousActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    chooseButtonRef.current?.focus();
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]):not([type="file"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
      const active = document.activeElement;
      if (!(active instanceof Node) || !items.some((item) => item === active)) {
        // The focused action can become disabled or be removed mid-interaction
        // (busy or success), and some browsers or jsdom keep focus on that now
        // non-focusable element. Pull the next Tab back into the dialog.
        event.preventDefault();
        if (event.shiftKey) last.focus();
        else first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
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

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (next === null) return;
    discardPending();
    setSelectedFile(next);
    setProgress(null);
    setReport(null);
    setPageIndex(0);
    if (next.size === 0) {
      setError({ message: EMPTY_FILE_MESSAGE });
      setPhase("error");
      return;
    }
    if (next.size > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) {
      setError({
        message: `The selected ZIP is larger than ${formatBytes(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES)}.`,
      });
      setPhase("error");
      return;
    }
    setError(null);
    setPhase("idle");
  };

  const startCheck = useCallback(async () => {
    if (busyRef.current) return;
    if (selectedFile === null) return;
    if (selectedFile.size === 0) {
      setError({ message: EMPTY_FILE_MESSAGE });
      setPhase("error");
      return;
    }
    if (selectedFile.size > WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES) {
      setError({
        message: `The selected ZIP is larger than ${formatBytes(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES)}.`,
      });
      setPhase("error");
      return;
    }
    setError(null);
    const requestId = ++requestIdRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    busyRef.current = true;
    setProgress(null);
    setPhase("busy");
    try {
      const result = await inspectArchiveInWorker(selectedFile, {
        signal: controller.signal,
        onProgress: (next) => {
          if (requestId === requestIdRef.current) setProgress(next);
        },
      });
      if (requestId !== requestIdRef.current) return;
      if (result === null || typeof result !== "object") {
        throw new Error(FALLBACK_ERROR_MESSAGE);
      }
      setReport(result);
      setPageIndex(0);
      setPhase("success");
    } catch (caught) {
      if (requestId !== requestIdRef.current) return;
      const failure = caught as InspectionFailureLike;
      const message =
        typeof failure.message === "string" && failure.message.trim() !== ""
          ? failure.message
          : FALLBACK_ERROR_MESSAGE;
      const path = typeof failure.path === "string" ? failure.path : undefined;
      if (failure.code === "cancelled") {
        setError({ message: CANCELLED_ERROR_MESSAGE, path });
      } else {
        setError({ message, path });
      }
      setPhase("error");
    } finally {
      // Release the worker request on settlement, errors, or stale returns so a
      // Cancel/new selection is not left holding the worker's reservation.
      controller.abort();
      if (requestId === requestIdRef.current) {
        busyRef.current = false;
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    }
  }, [selectedFile]);

  const handleCancel = () => {
    if (!busyRef.current) return;
    discardPending();
    setProgress(null);
    setError(null);
    setPhase("idle");
  };

  const handleCheckAnother = () => {
    discardPending();
    setSelectedFile(null);
    setProgress(null);
    setReport(null);
    setError(null);
    setPageIndex(0);
    setPhase("idle");
    openFilePicker();
  };

  const busy = phase === "busy";
  const entries = report?.manifest.entries ?? [];
  const totalPages = Math.max(
    1,
    Math.ceil(entries.length / WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE),
  );
  const pageEntries = entries.slice(
    pageIndex * WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE,
    (pageIndex + 1) * WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE,
  );

  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="modal modal-wide workspace-archive-inspection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">ARCHIVE</p>
            <h2 id={titleId}>Inspect workspace ZIP</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body workspace-archive-inspection-body">
          <p className="workspace-archive-explanation">
            Files stay in this browser and are not uploaded or imported. This accepts a Nexestra
            workspace export v1 ZIP and compares each stored file's hash with the archive manifest.
            It is not a guarantee of authenticity, completeness, or restorability.
          </p>
          <div className="workspace-archive-picker">
            <button
              ref={chooseButtonRef}
              type="button"
              className="secondary-button"
              onClick={openFilePicker}
            >
              <FileArchive size={15} />
              Choose ZIP
            </button>
            <input
              ref={fileInputRef}
              className="workspace-archive-file-input"
              type="file"
              accept=".zip,application/zip"
              aria-label="Choose ZIP"
              onChange={handleFileSelected}
            />
            {selectedFile !== null ? (
              <p className="workspace-archive-selected" title={selectedFile.name}>
                <strong>{selectedFile.name}</strong> · {formatBytes(selectedFile.size)}
              </p>
            ) : (
              <p className="workspace-archive-selected workspace-archive-selected-empty">
                No ZIP selected.
              </p>
            )}
          </div>
          {busy && (
            <p className="workspace-archive-status" role="status">
              <LoaderCircle className="spin" size={15} />
              {progressLabel(progress)}
            </p>
          )}
          {phase === "error" && error !== null && (
            <div className="form-error workspace-archive-error" role="alert">
              <span className="workspace-archive-error-message">{error.message}</span>
              {error.path !== undefined && (
                <code className="workspace-archive-error-path">{error.path}</code>
              )}
            </div>
          )}
          {phase === "success" && report !== null && (
            <>
              <p className="workspace-archive-status workspace-archive-success" role="status">
                <Check size={15} />
                Integrity verified
              </p>
              <dl className="workspace-archive-summary">
                <div>
                  <dt>Workspace</dt>
                  <dd>{report.manifest.workspace.name}</dd>
                </div>
                <div>
                  <dt>Export date</dt>
                  <dd>{formatExportDate(report.manifest.createdAt)}</dd>
                </div>
                <div>
                  <dt>Files</dt>
                  <dd>
                    {formatCount(report.manifest.entries.length)} payload files verified, plus
                    manifest
                  </dd>
                </div>
                <div>
                  <dt>Archive</dt>
                  <dd>{formatBytes(report.archiveBytes)}</dd>
                </div>
                <div>
                  <dt>Payload</dt>
                  <dd>{formatBytes(report.payloadBytes)}</dd>
                </div>
              </dl>
              <div className="workspace-archive-table-scroll">
                <table className="workspace-archive-table" aria-label="Verified archive entries">
                  <thead>
                    <tr>
                      <th scope="col">Path</th>
                      <th scope="col">Kind</th>
                      <th scope="col">Bytes</th>
                      <th scope="col">SHA-256</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageEntries.map((item) => (
                      <tr key={`${item.kind}:${item.path}:${item.sha256}`}>
                        <td className="workspace-archive-entry-path">{item.path}</td>
                        <td>{item.kind}</td>
                        <td>{formatBytes(item.bytes)}</td>
                        <td>
                          <code className="workspace-archive-entry-hash">{item.sha256}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <nav className="workspace-archive-pagination" aria-label="Archive entries pages">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pageIndex === 0}
                    onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                  >
                    Previous
                  </button>
                  <span>
                    Page {pageIndex + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={pageIndex === totalPages - 1}
                    onClick={() => setPageIndex((current) => Math.min(totalPages - 1, current + 1))}
                  >
                    Next
                  </button>
                </nav>
              )}
            </>
          )}
        </div>
        <div className="modal-actions workspace-archive-actions">
          {busy && (
            <button type="button" className="secondary-button" onClick={handleCancel}>
              Cancel check
            </button>
          )}
          {phase === "idle" && (
            <button
              type="button"
              className="primary-button"
              disabled={selectedFile === null}
              onClick={() => {
                void startCheck();
              }}
            >
              <Check size={15} />
              Check ZIP
            </button>
          )}
          {busy && (
            <button type="button" className="primary-button" disabled>
              <LoaderCircle className="spin" size={15} />
              Checking…
            </button>
          )}
          {phase === "error" && (
            <>
              <button type="button" className="secondary-button" onClick={openFilePicker}>
                Choose another ZIP
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  void startCheck();
                }}
              >
                <RefreshCw size={15} />
                Try again
              </button>
            </>
          )}
          {phase === "success" && (
            <button type="button" className="primary-button" onClick={handleCheckAnother}>
              <FileArchive size={15} />
              Check another ZIP
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
