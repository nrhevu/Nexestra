// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RefreshOutcome, useWorkspaceRefresh } from "./workspaceRefresh.js";

function deferred() {
  let resolve: (outcome: RefreshOutcome) => void = () => {};
  const promise = new Promise<RefreshOutcome>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function Harness({
  workspaceId = "ws-1",
  visible = () => true,
  coalesceMs = 10,
  revalidate,
}: {
  workspaceId?: string;
  visible?: () => boolean;
  coalesceMs?: number;
  revalidate?: (workspaceId: string, signal: AbortSignal) => Promise<RefreshOutcome>;
}) {
  const controller = useWorkspaceRefresh({
    workspaceId,
    isVisible: visible,
    coalesceMs,
    revalidate: revalidate ?? (async () => "ok"),
  });
  return (
    <div>
      <span data-testid="status">{controller.status}</span>
      {controller.error && <span data-testid="error">{controller.error}</span>}
      <button type="button" onClick={controller.requestRefresh}>
        Refresh now
      </button>
    </div>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushResume() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
}

describe("useWorkspaceRefresh", () => {
  it("coalesces a burst of resume events into one revalidation cycle", async () => {
    const revalidate = vi.fn(async (): Promise<RefreshOutcome> => "ok");
    render(<Harness revalidate={revalidate} />);
    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
      fireEvent(document, new Event("visibilitychange"));
      fireEvent(window, new Event("online"));
    });
    expect(revalidate).not.toHaveBeenCalled();
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
  });

  it("runs one follow-up after a distinct later resume while work is pending", async () => {
    const first = deferred();
    const second = deferred();
    const calls: string[] = [];
    const revalidate = vi.fn(async (workspaceId: string): Promise<RefreshOutcome> => {
      calls.push(workspaceId);
      return calls.length === 1 ? first.promise : second.promise;
    });
    render(<Harness revalidate={revalidate} />);
    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
      fireEvent(document, new Event("visibilitychange"));
      fireEvent(window, new Event("online"));
    });
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve("ok");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("status")).toHaveTextContent("refreshing");

    await act(async () => {
      second.resolve("ok");
    });
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(calls).toEqual(["ws-1", "ws-1"]);
  });

  it("does not revalidate while hidden and does revalidate when visible again", async () => {
    const visible = { value: false };
    const revalidate = vi.fn(async (): Promise<RefreshOutcome> => "ok");
    render(<Harness visible={() => visible.value} revalidate={revalidate} />);
    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
      fireEvent(document, new Event("visibilitychange"));
    });
    await flushResume();
    expect(revalidate).not.toHaveBeenCalled();

    visible.value = true;
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("runs a manual refresh immediately and uses the pending slot once for repeat clicks", async () => {
    const first = deferred();
    const second = deferred();
    const calls: string[] = [];
    const revalidate = vi.fn(async (workspaceId: string): Promise<RefreshOutcome> => {
      calls.push(workspaceId);
      return calls.length === 1 ? first.promise : second.promise;
    });
    render(<Harness revalidate={revalidate} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(revalidate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(revalidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve("ok");
    });
    expect(revalidate).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve("ok");
    });
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("reports an actual failure, retries with the button, and clears the error", async () => {
    const revalidate = vi
      .fn(async (): Promise<RefreshOutcome> => "ok")
      .mockResolvedValueOnce("failed" as const);
    render(<Harness revalidate={revalidate} />);
    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    await flushResume();
    expect(screen.getByTestId("status")).toHaveTextContent("error");
    expect(screen.getByTestId("error")).toHaveTextContent("Could not refresh the workspace.");

    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await act(async () => {});
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(screen.queryByTestId("error")).not.toBeInTheDocument();
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("aborts the previous workspace request on switch and retires queued work", async () => {
    const pending = deferred();
    const aborted: AbortSignal[] = [];
    const revalidate = vi.fn((_workspaceId: string, signal: AbortSignal) => {
      aborted.push(signal);
      return pending.promise;
    });
    const view = render(<Harness revalidate={revalidate} />);
    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    await flushResume();
    expect(screen.getByTestId("status")).toHaveTextContent("refreshing");
    expect(aborted[0]?.aborted).toBe(false);

    view.rerender(<Harness workspaceId="ws-2" revalidate={revalidate} />);
    expect(aborted[0]?.aborted).toBe(true);
    expect(screen.getByTestId("status")).toHaveTextContent("idle");

    await act(async () => {
      pending.resolve("failed");
    });
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(screen.queryByTestId("error")).not.toBeInTheDocument();
  });

  it("aborts pending work on unmount so nothing starts later", async () => {
    const pending = deferred();
    const aborted: AbortSignal[] = [];
    const revalidate = vi.fn((_workspaceId: string, signal: AbortSignal) => {
      aborted.push(signal);
      return pending.promise;
    });
    const view = render(<Harness revalidate={revalidate} />);
    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    await flushResume();
    expect(aborted[0]?.aborted).toBe(false);
    view.unmount();
    expect(aborted[0]?.aborted).toBe(true);

    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });
});

describe("Visibility gating", () => {
  it("does not start the debounced cycle after the tab becomes hidden", async () => {
    const visible = { value: true };
    const revalidate = vi.fn(async (): Promise<RefreshOutcome> => "ok");
    render(<Harness visible={() => visible.value} revalidate={revalidate} />);

    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    expect(revalidate).not.toHaveBeenCalled();

    visible.value = false;
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(revalidate).not.toHaveBeenCalled();
    await flushResume();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("drops queued automatic follow-up when hidden and restarts on a later visible resume", async () => {
    const visible = { value: true };
    const first = deferred();
    const second = deferred();
    const calls: string[] = [];
    const revalidate = vi.fn(async (workspaceId: string): Promise<RefreshOutcome> => {
      calls.push(workspaceId);
      return calls.length === 1 ? first.promise : second.promise;
    });
    render(<Harness visible={() => visible.value} revalidate={revalidate} />);
    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent(window, new FocusEvent("focus"));
    });
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(1);

    visible.value = false;
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });

    await act(async () => {
      first.resolve("ok");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(revalidate).toHaveBeenCalledTimes(1);

    visible.value = true;
    await act(async () => {
      fireEvent(document, new Event("visibilitychange"));
    });
    await flushResume();
    expect(revalidate).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve("ok");
    });
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
  });
});

describe("Timeout", () => {
  it("closes a never-settling revalidate at 30s, shows error, retry succeeds, late resolve ignored", async () => {
    let attempt = 0;
    let firstSignal: AbortSignal | undefined;
    let resolveLate: ((outcome: RefreshOutcome) => void) | undefined;
    const revalidate = vi.fn((_workspaceId: string, signal: AbortSignal) => {
      attempt += 1;
      if (attempt === 1) {
        firstSignal = signal;
        return new Promise<RefreshOutcome>((resolve) => {
          resolveLate = resolve;
        });
      }
      return Promise.resolve("ok" as const);
    });
    render(<Harness revalidate={revalidate} />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(screen.getByTestId("status")).toHaveTextContent("refreshing");
    expect(attempt).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByTestId("status")).toHaveTextContent("error");
    expect(screen.getByTestId("error")).toHaveTextContent("Could not refresh the workspace.");

    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await act(async () => {});
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(attempt).toBe(2);

    await act(async () => {
      resolveLate?.("failed");
    });
    expect(screen.getByTestId("status")).toHaveTextContent("idle");
    expect(screen.queryByTestId("error")).not.toBeInTheDocument();
  });
});
