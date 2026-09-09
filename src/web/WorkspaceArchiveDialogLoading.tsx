import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { WorkspaceArchiveDialogLoadingProps } from "./workspace-archive-dialog-contracts.js";
import "./WorkspaceArchiveDialogLoading.css";

const TITLES: Record<WorkspaceArchiveDialogLoadingProps["kind"], string> = {
  export: "Export workspace",
  inspection: "Inspect workspace ZIP",
};

const PENDING_COPY: Record<WorkspaceArchiveDialogLoadingProps["kind"], string> = {
  export: "Loading export dialog…",
  inspection: "Loading ZIP inspector…",
};

const FAILURE_COPY: Record<NonNullable<WorkspaceArchiveDialogLoadingProps["failure"]>, string> = {
  load: "The dialog could not be loaded.",
  timeout: "The dialog timed out while loading.",
};

export function WorkspaceArchiveDialogLoading({
  kind,
  failure,
  onRetry,
  onClose,
}: WorkspaceArchiveDialogLoadingProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  useEffect(() => {
    closeButtonRef.current?.focus();
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
      const active = document.activeElement;
      if (!(active instanceof Node) || !items.some((item) => item === active)) {
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
    };
  }, []);

  return (
    <div className="modal-backdrop">
      <section
        ref={dialogRef}
        className="modal workspace-archive-dialog-loading"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div>
            <p className="eyebrow">ARCHIVE</p>
            <h2 id={titleId}>{TITLES[kind]}</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="workspace-archive-dialog-loading-body">
          {failure === null ? (
            <p className="workspace-archive-dialog-loading-status" role="status">
              <LoaderCircle className="spin" size={15} />
              {PENDING_COPY[kind]}
            </p>
          ) : (
            <div className="workspace-archive-dialog-loading-error" role="alert">
              <p className="workspace-archive-dialog-loading-error-text">{FAILURE_COPY[failure]}</p>
              <p className="workspace-archive-dialog-loading-hint">
                No export or inspection was started. Close the dialog and try again, or retry
                loading.
              </p>
            </div>
          )}
        </div>
        {failure !== null && (
          <div className="modal-actions workspace-archive-dialog-loading-actions">
            <button type="button" className="secondary-button" onClick={() => onRetryRef.current()}>
              <RefreshCw size={15} />
              Retry loading
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
