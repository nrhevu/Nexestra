import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { Thread } from "../shared/contracts.js";
import { ReadState } from "./readState.js";

export interface LatestReadEligibility {
  workspaceId: string | undefined;
  routeThreadId: string | undefined;
  modalOpen: boolean;
  documentVisible: boolean;
  windowFocused: boolean;
  bottomVisible: boolean;
  history?: {
    threadId: string;
    windowKind: "latest" | "around" | "before" | "after" | "at";
    lastMessageIndex: number;
  };
}

// The only count that may advance a read marker is one proven loaded and visible on the
// latest page. Metadata totals, linked/older pages, hidden tabs, unfocused windows,
// covered dialogs, and bottom sentinels outside the current thread are all ignored.
export function latestReadThrough(options: LatestReadEligibility): number | undefined {
  if (
    !options.workspaceId ||
    options.routeThreadId === undefined ||
    options.modalOpen ||
    !options.documentVisible ||
    !options.windowFocused ||
    !options.bottomVisible ||
    !options.history ||
    options.history.threadId !== options.routeThreadId ||
    options.history.windowKind !== "latest" ||
    options.history.lastMessageIndex <= 0
  ) {
    return undefined;
  }
  return options.history.lastMessageIndex;
}

export function threadUnread(
  readState: ReadState,
  workspaceId: string | undefined,
  thread: Thread | undefined,
): number {
  if (!workspaceId || !thread || thread.workspaceId !== workspaceId) return 0;
  return readState.unread(workspaceId, thread.id, thread.messageCount);
}

export function totalUnread(
  readState: ReadState,
  workspaceId: string | undefined,
  threads: ReadonlyArray<Thread>,
): number {
  if (!workspaceId) return 0;
  let total = 0;
  for (const thread of threads) {
    if (thread.workspaceId !== workspaceId) continue;
    total += readState.unread(workspaceId, thread.id, thread.messageCount);
  }
  return total;
}

function bottomIsVisible(node: HTMLElement | null): boolean {
  if (!node) return false;
  const container = node.closest(".message-scroll") as HTMLElement | null;
  if (!container) return false;
  const containerRect = container.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const viewportBottom = typeof window !== "undefined" ? window.innerHeight : containerRect.bottom;
  const top = Math.max(containerRect.top, 0);
  const bottom = Math.min(containerRect.bottom, viewportBottom);
  if (bottom - top <= 0) return false;
  return nodeRect.top >= top - 1 && nodeRect.top <= bottom + 1;
}

// Observes the transcript bottom sentinel and can re-measure geometry after layout.
// Callbacks are routed through a ref so the observer never needs recreation, queued
// intersections are ignored once the component unmounts, and cleanup explicitly retires
// the last visible=true so a later Files & links page or history refresh cannot reuse it.
export function useLatestBottomVisibility(onChange: (visible: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const frameRef = useRef<number | null>(null);
  onChangeRef.current = onChange;

  const measure = useCallback(() => {
    if (typeof requestAnimationFrame !== "function") {
      onChangeRef.current(bottomIsVisible(ref.current));
      return;
    }
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      onChangeRef.current(bottomIsVisible(ref.current));
    });
  }, []);

  useEffect(() => {
    const node = ref.current;
    let alive = true;
    let observer: IntersectionObserver | undefined;
    if (node && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          if (!alive) return;
          for (const entry of entries) {
            // Intersection state can be queued from an earlier page layout. Read the
            // sentinel's actual geometry at callback time so a stale pending entry
            // cannot report visible for content that has since moved offscreen.
            const target =
              entry.target instanceof Element ? (entry.target as HTMLElement) : ref.current;
            onChangeRef.current(bottomIsVisible(target));
          }
        },
        { threshold: 0 },
      );
      observer.observe(node);
    }
    return () => {
      alive = false;
      observer?.disconnect();
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      onChangeRef.current(false);
    };
  }, []);

  return { ref: ref as RefObject<HTMLDivElement | null>, measure };
}

export { ReadState };
