// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "../shared/contracts.js";
import { ReadState } from "./readState.js";
import {
  type LatestReadEligibility,
  latestReadThrough,
  totalUnread,
  useLatestBottomVisibility,
} from "./unreadConversations.js";

function thread(id: string, count: number, archived = false): Thread {
  return {
    id,
    workspaceId: "workspace-a",
    name: id,
    slug: id,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    messageCount: count,
    lastMessageAt: "2026-09-09T00:00:00.000Z",
    archived,
  };
}

type VisibilityEntry = { isIntersecting: boolean };
type VisibilityCallback = (entries: VisibilityEntry[]) => void;
const observerCallbacks: VisibilityCallback[] = [];

class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: VisibilityCallback) {
    observerCallbacks.push(callback);
  }
}

function Harness({ onChange }: { onChange: (visible: boolean) => void }) {
  const { ref, measure } = useLatestBottomVisibility(onChange);
  return (
    <div className="message-scroll">
      <div data-testid="sentinel" ref={ref} />
      <button type="button" onClick={() => measure()}>
        Measure
      </button>
    </div>
  );
}

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: Math.max(0, bottom - top),
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  observerCallbacks.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("latestReadThrough", () => {
  const base: LatestReadEligibility = {
    workspaceId: "workspace-a",
    routeThreadId: "thread-1",
    modalOpen: false,
    documentVisible: true,
    windowFocused: true,
    bottomVisible: true,
    history: {
      threadId: "thread-1",
      windowKind: "latest",
      lastMessageIndex: 7,
    },
  };

  it("returns the loaded latest count only when every viewport gate passes", () => {
    expect(latestReadThrough(base)).toBe(7);
    expect(latestReadThrough({ ...base, modalOpen: true })).toBeUndefined();
    expect(latestReadThrough({ ...base, documentVisible: false })).toBeUndefined();
    expect(latestReadThrough({ ...base, windowFocused: false })).toBeUndefined();
    expect(latestReadThrough({ ...base, bottomVisible: false })).toBeUndefined();
    expect(
      latestReadThrough({ ...base, history: { ...base.history!, windowKind: "before" } }),
    ).toBeUndefined();
    expect(
      latestReadThrough({ ...base, history: { ...base.history!, threadId: "thread-other" } }),
    ).toBeUndefined();
    expect(
      latestReadThrough({
        ...base,
        history: { ...base.history!, lastMessageIndex: 0 },
      }),
    ).toBeUndefined();
    expect(
      latestReadThrough({
        ...base,
        history: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("totalUnread", () => {
  it("includes archived conversations so mark-all stays reachable", () => {
    const state = new ReadState();
    const active = thread("active", 5);
    const archived = thread("archived", 3, true);
    state.observe("workspace-a", [active, archived]);
    expect(totalUnread(state, "workspace-a", [active, { ...archived, messageCount: 8 }])).toBe(5);
    state.markAllRead("workspace-a", [active, archived]);
    expect(totalUnread(state, "workspace-a", [active, archived])).toBe(0);
  });
});

describe("useLatestBottomVisibility", () => {
  function geometry(visibleTop = 50) {
    const container = screen
      .getByRole("button", { name: "Measure" })
      .closest(".message-scroll") as HTMLElement;
    const sentinel = screen.getByTestId("sentinel");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(rect(0, 100));
    vi.spyOn(sentinel, "getBoundingClientRect").mockReturnValue(rect(visibleTop, visibleTop));
    return { container, sentinel };
  }

  it("reports actual sentinel geometry and retires visible on cleanup", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const onChange = vi.fn();
    const view = render(<Harness onChange={onChange} />);
    geometry();
    const callback = observerCallbacks.at(-1)!;
    act(() => callback([{ isIntersecting: true }]));
    expect(onChange).toHaveBeenLastCalledWith(true);
    view.unmount();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("ignores queued observer callbacks after unmount", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const onChange = vi.fn();
    const view = render(<Harness onChange={onChange} />);
    geometry();
    const callback = observerCallbacks.at(-1)!;
    view.unmount();
    const callsAfterUnmount = onChange.mock.calls.length;
    act(() => callback([{ isIntersecting: true }]));
    expect(onChange.mock.calls.length).toBe(callsAfterUnmount);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("rejects a queued old callback after a newer page pushes the sentinel below the viewport", () => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const { sentinel } = geometry();
    const callback = observerCallbacks.at(-1)!;
    act(() => callback([{ isIntersecting: true }]));
    expect(onChange).toHaveBeenLastCalledWith(true);
    // A newer page finished loading and moved the sentinel down before the old
    // queued intersection entry was delivered. isIntersecting is stale; the
    // callback must read the current geometry and report false.
    vi.spyOn(sentinel, "getBoundingClientRect").mockReturnValue(rect(200, 200));
    act(() => callback([{ isIntersecting: true }]));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("re-measures actual sentinel geometry on demand", () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    geometry();
    fireEvent.click(screen.getByRole("button", { name: "Measure" }));
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});
