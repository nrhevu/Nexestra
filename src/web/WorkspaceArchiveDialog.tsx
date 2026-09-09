import { useEffect, useRef, useState } from "react";
import { WorkspaceArchiveDialogLoading } from "./WorkspaceArchiveDialogLoading.js";
import type {
  WorkspaceArchiveDialogComponent,
  WorkspaceArchiveDialogKind,
  WorkspaceArchiveDialogProps,
} from "./workspace-archive-dialog-contracts.js";
import {
  loadWorkspaceArchiveDialog,
  WorkspaceArchiveDialogLoadError,
} from "./workspace-archive-dialog-loader.js";

type DialogFailure = "load" | "timeout" | null;

interface LoadedDialog {
  component: WorkspaceArchiveDialogComponent;
  kind: WorkspaceArchiveDialogKind;
  workspaceId: string;
}

let focusEpoch = 0;

/**
 * Loads archive dialogs on demand and renders the loading shell until the
 * requested module is ready. The wrapper owns pre-open focus restoration after
 * the loading-to-ready handoff and after the real dialog's own focus cleanup;
 * a module-level epoch prevents a late restore timer from a strict-mode
 * remount or an immediately replaced dialog from stealing focus, and the
 * restore itself yields to any connected control that was focused while the
 * dialog was open.
 */
export function WorkspaceArchiveDialog({ kind, workspace, onClose }: WorkspaceArchiveDialogProps) {
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<DialogFailure>(null);
  const [loaded, setLoaded] = useState<LoadedDialog | null>(null);
  const originalFocusRef = useRef<HTMLElement | null>(null);
  const attemptRef = useRef(0);

  if (originalFocusRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    originalFocusRef.current = active instanceof HTMLElement ? active : null;
  }

  useEffect(() => {
    const epoch = focusEpoch + 1;
    focusEpoch = epoch;
    return () => {
      const original = originalFocusRef.current;
      setTimeout(() => {
        if (focusEpoch !== epoch) {
          return;
        }
        const active = typeof document === "undefined" ? null : document.activeElement;
        if (
          active instanceof HTMLElement &&
          active.isConnected &&
          active !== document.body &&
          active !== original
        ) {
          return;
        }
        original?.focus();
      }, 0);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFailure(null);

    loadWorkspaceArchiveDialog(kind).then(
      (component) => {
        if (cancelled || attemptRef.current !== attempt) {
          return;
        }
        setLoaded({
          component,
          kind,
          workspaceId: workspace.id,
        });
      },
      (error: unknown) => {
        if (cancelled || attemptRef.current !== attempt) {
          return;
        }
        setFailure(error instanceof WorkspaceArchiveDialogLoadError ? error.reason : "load");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, kind, workspace.id]);

  const handleRetry = (): void => {
    setFailure(null);
    setLoaded(null);
    attemptRef.current += 1;
    setAttempt(attemptRef.current);
  };

  const isReady =
    loaded !== null &&
    loaded.kind === kind &&
    loaded.workspaceId === workspace.id &&
    failure === null;

  if (isReady) {
    const Content = loaded.component;
    return <Content workspace={workspace} onClose={onClose} />;
  }

  return (
    <WorkspaceArchiveDialogLoading
      kind={kind}
      failure={failure}
      onRetry={handleRetry}
      onClose={onClose}
    />
  );
}
