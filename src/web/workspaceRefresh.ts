import { useCallback, useEffect, useRef, useState } from "react";

export type RefreshOutcome = "ok" | "failed" | "superseded";

export type WorkspaceRefreshStatus = "idle" | "refreshing" | "error";

/** Hung resume reads are aborted and the cycle closed after this long; retry stays available. */
export const REVALIDATION_TIMEOUT_MS = 30_000;

export interface WorkspaceRefreshController {
  status: WorkspaceRefreshStatus;
  error?: string;
  requestRefresh: () => void;
}

export interface WorkspaceRefreshOptions {
  /** The workspace that should be revalidated. Changes reset status and queued work. */
  workspaceId: string | undefined;
  /**
   * Runs the actual revalidation. The signal is aborted when the workspace changes,
   * the hook unmounts, or the read exceeds the timeout. A revalidation that never
   * settles is retired by the coordinator at the same deadline.
   */
  revalidate: (workspaceId: string, signal: AbortSignal) => Promise<RefreshOutcome>;
  /**
   * Whether the document is currently visible. The default follows the Page Visibility API;
   * revalidation never starts while hidden and queued automatic work is dropped on hide.
   */
  isVisible?: () => boolean;
  /** Resume events within this window are coalesced into one revalidation cycle. */
  coalesceMs?: number;
}

const DEFAULT_COALESCE_MS = 400;

interface ActiveCycle {
  workspaceId: string;
  serial: number;
  controller: AbortController;
  timeoutId: number;
}

interface PendingCycle {
  workspaceId: string;
  serial: number;
  manual: boolean;
}

export function useWorkspaceRefresh(options: WorkspaceRefreshOptions): WorkspaceRefreshController {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [status, setStatus] = useState<WorkspaceRefreshStatus>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const statusKeyRef = useRef<string | undefined>(undefined);
  const activeRef = useRef<ActiveCycle | undefined>(undefined);
  const pendingRef = useRef<PendingCycle | undefined>(undefined);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const serialRef = useRef(0);

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== undefined) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = undefined;
    }
  }, []);

  const isDocumentVisible = useCallback(() => {
    const current = optionsRef.current;
    const isVisible = current.isVisible ?? (() => document.visibilityState !== "hidden");
    return isVisible();
  }, []);

  const retire = useCallback((active: ActiveCycle) => {
    window.clearTimeout(active.timeoutId);
    active.controller.abort();
  }, []);

  const start = useCallback(
    (workspaceId: string, manual = false) => {
      if (statusKeyRef.current !== workspaceId) return;
      if (!manual && !isDocumentVisible()) return;
      if (activeRef.current) {
        // Coalesce bursts: a manual request (or another manual queued behind it) replaces
        // the single pending slot; automatic resume events never stack more work.
        if (manual || pendingRef.current?.manual) {
          pendingRef.current = {
            workspaceId,
            serial: ++serialRef.current,
            manual: true,
          };
        }
        return;
      }
      clearDebounce();
      const controller = new AbortController();
      const serial = ++serialRef.current;
      const cycle: ActiveCycle = { workspaceId, serial, controller, timeoutId: 0 };
      const finishCycle = (outcome: RefreshOutcome) => {
        if (activeRef.current?.serial !== serial) return;
        window.clearTimeout(cycle.timeoutId);
        activeRef.current = undefined;
        const pending = pendingRef.current;
        if (pending && (pending.manual || isDocumentVisible())) {
          pendingRef.current = undefined;
          start(pending.workspaceId, pending.manual);
          return;
        }
        // Drop automatic pending work queued for a tab that went hidden, then finalize
        // this cycle so Refresh never stays busy with no active work behind it.
        pendingRef.current = undefined;
        if (statusKeyRef.current !== workspaceId) return;
        if (outcome === "failed") {
          setStatus("error");
          setError("Could not refresh the workspace.");
        } else {
          setStatus("idle");
        }
      };
      cycle.timeoutId = window.setTimeout(() => {
        if (controller.signal.aborted) return;
        controller.abort();
        // Close the cycle at the actual deadline even if the revalidation ignores the
        // abort and never settles; serial guards ignore its late completion.
        finishCycle("failed");
      }, REVALIDATION_TIMEOUT_MS) as unknown as number;
      activeRef.current = cycle;
      setStatus("refreshing");
      setError(undefined);
      void (async () => {
        let outcome: RefreshOutcome;
        try {
          outcome = await optionsRef.current.revalidate(workspaceId, controller.signal);
        } catch {
          outcome = "failed";
        }
        finishCycle(outcome);
      })();
    },
    [clearDebounce, isDocumentVisible],
  );

  const schedule = useCallback(
    (workspaceId: string) => {
      if (statusKeyRef.current !== workspaceId) return;
      if (debounceTimerRef.current !== undefined) return;
      if (activeRef.current || pendingRef.current) {
        if (!pendingRef.current) {
          pendingRef.current = { workspaceId, serial: ++serialRef.current, manual: false };
        }
        return;
      }
      const delayMs = optionsRef.current.coalesceMs ?? DEFAULT_COALESCE_MS;
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = undefined;
        start(workspaceId);
      }, delayMs) as unknown as number;
    },
    [start],
  );

  const requestRefresh = useCallback(() => {
    const workspaceId = optionsRef.current.workspaceId;
    if (!workspaceId) return;
    clearDebounce();
    start(workspaceId, true);
  }, [clearDebounce, start]);

  useEffect(() => {
    if (statusKeyRef.current === options.workspaceId) return;
    statusKeyRef.current = options.workspaceId;
    clearDebounce();
    pendingRef.current = undefined;
    const active = activeRef.current;
    activeRef.current = undefined;
    if (active && active.workspaceId !== options.workspaceId) retire(active);
    setStatus("idle");
    setError(undefined);
  }, [clearDebounce, options.workspaceId, retire]);

  useEffect(() => {
    const considerResume = () => {
      const current = optionsRef.current;
      const isVisible = current.isVisible ?? (() => document.visibilityState !== "hidden");
      if (!current.workspaceId) return;
      if (!isVisible()) {
        clearDebounce();
        if (pendingRef.current && !pendingRef.current.manual) pendingRef.current = undefined;
        return;
      }
      schedule(current.workspaceId);
    };
    window.addEventListener("focus", considerResume);
    document.addEventListener("visibilitychange", considerResume);
    window.addEventListener("online", considerResume);
    return () => {
      window.removeEventListener("focus", considerResume);
      document.removeEventListener("visibilitychange", considerResume);
      window.removeEventListener("online", considerResume);
    };
  }, [clearDebounce, schedule]);

  useEffect(() => {
    return () => {
      clearDebounce();
      pendingRef.current = undefined;
      const active = activeRef.current;
      activeRef.current = undefined;
      if (active) retire(active);
    };
  }, [clearDebounce, retire]);

  return { status, error, requestRefresh };
}
