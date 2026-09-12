// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRun,
  AgentView,
  RunHistoryItem,
  RunHistoryPage,
  Thread,
} from "../shared/contracts.js";
import { RunHistoryView } from "./RunHistoryView.js";

const now = "2026-09-02T12:00:00.000Z";
const workspaceId = "workspace-notes";

function makeAgent(id: string, name: string, ws = workspaceId, archived = false): AgentView {
  return {
    id,
    workspaceId: ws,
    kind: "worker",
    name,
    handle: name.toLowerCase(),
    description: "",
    instructions: "",
    enabled: true,
    archived,
    harness: "codex",
    createdAt: now,
    updatedAt: now,
    readiness: "ready",
    readinessLabel: "Ready",
  };
}

function makeThread(id: string, name: string, ws = workspaceId, archived = false): Thread {
  return {
    id,
    workspaceId: ws,
    name,
    slug: name.toLowerCase(),
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    lastMessageAt: now,
    archived,
  };
}

function makeRun(id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    threadId: "thread-a",
    triggerMessageId: `message-${id}`,
    agentId: "agent-a",
    attempt: 1,
    status: "completed",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeItem(run: AgentRun, overrides: Partial<RunHistoryItem> = {}): RunHistoryItem {
  return {
    run,
    agentName: "Planner",
    agentHandle: "planner",
    threadName: "Planning",
    threadArchived: false,
    ...overrides,
  };
}

function makePage(
  items: RunHistoryItem[],
  nextCursor: string | null = null,
  overrides: Partial<RunHistoryPage> = {},
): RunHistoryPage {
  return {
    workspaceId,
    items,
    page: { nextCursor },
    summary: {
      totalRuns: items.length,
      terminalRuns: 0,
      totalDurationMs: 0,
      usageRuns: 0,
      totalTokens: 0,
      byAgent: [],
    },
    coverage: { complete: true, unavailableThreads: 0 },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pageParams(input: RequestInfo | URL): URLSearchParams {
  return new URL(String(input), "http://localhost").searchParams;
}

function fetchInputAt(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  index: number,
): RequestInfo | URL {
  const call = mock.mock.calls[index];
  if (!call || call.length === 0) throw new Error(`missing fetch call at ${index}`);
  return call[0] as RequestInfo | URL;
}

function lastFetchInput(mock: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): RequestInfo | URL {
  const call = mock.mock.calls.at(-1);
  if (!call || call.length === 0) throw new Error("missing fetch call");
  return call[0] as RequestInfo | URL;
}

function renderView(
  overrides: Partial<{
    workspaceId: string;
    agents: AgentView[];
    threads: Thread[];
    refreshRevision: number;
    onOpenRun: (item: RunHistoryItem) => void;
  }> = {},
) {
  return render(
    <RunHistoryView
      workspaceId={overrides.workspaceId ?? workspaceId}
      agents={overrides.agents ?? [makeAgent("agent-a", "Planner")]}
      threads={overrides.threads ?? [makeThread("thread-a", "Planning")]}
      refreshRevision={overrides.refreshRevision}
      onOpenRun={overrides.onOpenRun ?? vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RunHistoryView requests and filters", () => {
  it("loads the first page, pages older with cursor, goes newer back, and resets on status filter", async () => {
    const user = userEvent.setup();
    const first = makeItem(makeRun("run-1"));
    const second = makeItem(makeRun("run-2", { status: "failed", attempt: 2 }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const params = pageParams(input);
      if (params.get("cursor") === "cursor-2") {
        return jsonResponse(makePage([second], "cursor-3"));
      }
      return jsonResponse(makePage([first], "cursor-2"));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    const firstCard = await screen.findByLabelText("Run run-1");
    expect(within(firstCard).getByText("Planner (planner)")).toBeVisible();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    const initialParams = pageParams(fetchInputAt(fetchMock, 0));
    expect(initialParams.get("workspaceId")).toBe(workspaceId);
    expect(initialParams.get("limit")).toBe("50");

    await user.click(screen.getByRole("button", { name: "Older runs" }));
    await waitFor(() => expect(screen.getByText("Page 2")).toBeInTheDocument());
    expect(screen.getByLabelText("Run run-2")).toBeInTheDocument();
    expect(pageParams(fetchInputAt(fetchMock, 1)).get("cursor")).toBe("cursor-2");

    await user.click(screen.getByRole("button", { name: "Newer runs" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(pageParams(fetchInputAt(fetchMock, 2)).has("cursor")).toBe(false);
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Run run-2")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Run status"), "completed");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const filtered = pageParams(fetchInputAt(fetchMock, 3));
    expect(filtered.get("status")).toBe("completed");
    expect(filtered.has("cursor")).toBe(false);
    expect(screen.getByText("Page 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Run run-2")).not.toBeInTheDocument();
  });

  it("sends agent and conversation filters and scopes options to the workspace", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => jsonResponse(makePage([makeItem(makeRun("run-1"))])));
    vi.stubGlobal("fetch", fetchMock);
    renderView({
      agents: [
        makeAgent("agent-a", "Planner"),
        makeAgent("agent-foreign", "Foreign", "workspace-other"),
      ],
      threads: [
        makeThread("thread-a", "Planning"),
        makeThread("thread-archived", "Archive", workspaceId, true),
        makeThread("thread-foreign", "Other", "workspace-other"),
      ],
    });
    await screen.findByLabelText("Run run-1");

    const agentSelect = screen.getByLabelText("Run agent");
    expect(agentSelect).toHaveTextContent("All agents");
    expect(within(agentSelect).queryByText("Foreign")).not.toBeInTheDocument();

    await user.selectOptions(agentSelect, "agent-a");
    await waitFor(() =>
      expect(pageParams(lastFetchInput(fetchMock)).get("agentId")).toBe("agent-a"),
    );

    const threadSelect = screen.getByLabelText("Run conversation");
    expect(within(threadSelect).getByText("Archive (archived)")).toBeInTheDocument();
    expect(within(threadSelect).queryByText("Other")).not.toBeInTheDocument();

    await user.selectOptions(threadSelect, "thread-archived");
    await waitFor(() =>
      expect(pageParams(lastFetchInput(fetchMock)).get("threadId")).toBe("thread-archived"),
    );
    const params = pageParams(lastFetchInput(fetchMock));
    expect(params.get("agentId")).toBe("agent-a");
  });
});

describe("RunHistoryView race and refresh behavior", () => {
  it("ignores a stale first-page response that finishes after a filter change", async () => {
    const user = userEvent.setup();
    const initial = deferred<Response>();
    const filtered = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const params = pageParams(input);
      return params.get("status") === "failed" ? filtered.promise : initial.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderView();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByLabelText("Run status"), "failed");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      filtered.resolve(
        jsonResponse(makePage([makeItem(makeRun("run-failed", { status: "failed" }))])),
      );
    });
    expect(await screen.findByLabelText("Run run-failed")).toBeInTheDocument();

    await act(async () => {
      initial.resolve(jsonResponse(makePage([makeItem(makeRun("run-stale"))])));
    });
    expect(screen.getByLabelText("Run run-failed")).toBeInTheDocument();
    expect(screen.queryByLabelText("Run run-stale")).not.toBeInTheDocument();
  });

  it("starts exactly one live request under React StrictMode remount replay", async () => {
    const initial = deferred<Response>();
    const fetchMock = vi.fn(() => initial.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(
      <StrictMode>
        <RunHistoryView
          workspaceId={workspaceId}
          agents={[makeAgent("agent-a", "Planner")]}
          threads={[makeThread("thread-a", "Planning")]}
          onOpenRun={vi.fn()}
        />
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("status")).toHaveTextContent("Loading run history…");

    await act(async () => {
      initial.resolve(jsonResponse(makePage([makeItem(makeRun("run-strict"))])));
    });
    expect(await screen.findByLabelText("Run run-strict")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("switches workspaces, aborts the old request, and never shows foreign rows", async () => {
    const foreign = deferred<Response>();
    const current = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const params = pageParams(input);
      return params.get("workspaceId") === "workspace-other" ? current.promise : foreign.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderView();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(
      <RunHistoryView
        workspaceId="workspace-other"
        agents={[makeAgent("agent-a", "Planner", "workspace-other")]}
        threads={[makeThread("thread-a", "Planning", "workspace-other")]}
        onOpenRun={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      foreign.resolve(jsonResponse(makePage([makeItem(makeRun("run-foreign"))])));
    });
    expect(screen.queryByLabelText("Run run-foreign")).not.toBeInTheDocument();

    await act(async () => {
      current.resolve(
        jsonResponse(
          makePage([makeItem(makeRun("run-current"))], null, {
            workspaceId: "workspace-other",
          }),
        ),
      );
    });
    expect(await screen.findByLabelText("Run run-current")).toBeInTheDocument();
  });

  it("shows an error with retry and prevents duplicate refresh requests while pending", async () => {
    const user = userEvent.setup();
    const second = deferred<Response>();
    let calls = 0;
    const fetchMock = vi.fn((_input: RequestInfo | URL) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("boom"));
      }
      return second.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("boom");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const refresh = screen.getByRole("button", { name: "Refresh run history" });
    expect(refresh).toBeDisabled();
    await user.click(refresh);
    await user.click(refresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(jsonResponse(makePage([makeItem(makeRun("run-refreshed"))])));
    });
    expect(await screen.findByLabelText("Run run-refreshed")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requeries the first page on refreshRevision while preserving filters", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => jsonResponse(makePage([makeItem(makeRun("run-1"))])));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderView();
    await screen.findByLabelText("Run run-1");

    await user.selectOptions(screen.getByLabelText("Run status"), "running");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    rerender(
      <RunHistoryView
        workspaceId={workspaceId}
        agents={[makeAgent("agent-a", "Planner")]}
        threads={[makeThread("thread-a", "Planning")]}
        refreshRevision={3}
        onOpenRun={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const params = pageParams(fetchInputAt(fetchMock, 2));
    expect(params.get("status")).toBe("running");
    expect(params.has("cursor")).toBe(false);
  });

  it("does not refetch when agents or threads array identity changes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(makePage([makeItem(makeRun("run-1"))])));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderView();
    await screen.findByLabelText("Run run-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(
      <RunHistoryView
        workspaceId={workspaceId}
        agents={[makeAgent("agent-a", "Planner")]}
        threads={[makeThread("thread-a", "Planning")]}
        onOpenRun={vi.fn()}
      />,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("settles a hanging request after 30 seconds with a visible retry", async () => {
    vi.useFakeTimers();
    const never = new Promise<Response>(() => {});
    const fetchMock = vi.fn(() => never);
    vi.stubGlobal("fetch", fetchMock);
    renderView();
    // The initial effect defers dispatch by one microtask so StrictMode teardown
    // can cancel the first setup; flush it before advancing the timeout timer.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Run history request timed out.");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeVisible();

    vi.useRealTimers();
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () =>
      jsonResponse(makePage([makeItem(makeRun("run-retried"))])),
    );
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Run run-retried")).toBeInTheDocument();
  });
});

describe("RunHistoryView coverage, rows, and callbacks", () => {
  it("shows the comparison breakdown by agent", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        makePage([], null, {
          summary: {
            totalRuns: 3,
            terminalRuns: 3,
            totalDurationMs: 4_000,
            usageRuns: 2,
            totalTokens: 2_500,
            byAgent: [
              {
                agentId: "agent-a",
                agentName: "Planner",
                totalRuns: 2,
                terminalRuns: 2,
                totalDurationMs: 3_000,
                usageRuns: 2,
                inputTokens: 2_000,
                outputTokens: 500,
                cachedInputTokens: 0,
                totalTokens: 2_500,
                estimatedCostUsd: 0.0125,
              },
              {
                agentId: "agent-b",
                agentName: "Reviewer",
                totalRuns: 1,
                terminalRuns: 1,
                totalDurationMs: 1_000,
                usageRuns: 0,
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                totalTokens: 0,
              },
            ],
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderView({ agents: [makeAgent("agent-a", "Planner"), makeAgent("agent-b", "Reviewer")] });

    const breakdown = await screen.findByRole("region", { name: "Run history by agent" });
    expect(within(breakdown).getByText("Planner")).toBeVisible();
    expect(
      within(breakdown).getByText("2 runs · 2.5K tokens (2K in / 500 out) · $0.0125 · 3.0 s"),
    ).toBeVisible();
    expect(within(breakdown).getByText("Reviewer")).toBeVisible();
    expect(within(breakdown).getByText("1 run · no usage · 1.0 s")).toBeVisible();
  });

  it("shows the coverage warning, safe date fallback, status, attempt, and archive label", async () => {
    const item = makeItem(
      makeRun("run-bad-dates", {
        status: "waiting_approval",
        attempt: 2,
        createdAt: "not-a-date",
        updatedAt: "still-bad",
      }),
      { threadArchived: true },
    );
    item.run.durationMs = 65_250;
    item.run.usage = { inputTokens: 1_000, outputTokens: 250, totalTokens: 1_250 };
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        makePage([item], null, {
          coverage: { complete: false, unavailableThreads: 2 },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    const card = await screen.findByLabelText("Run run-bad-dates");
    expect(
      screen.getByText("Run history is incomplete: 2 conversations could not be scanned."),
    ).toBeVisible();
    expect(within(card).getByText("Waiting for approval")).toBeVisible();
    expect(within(card).getByText("Attempt 2")).toBeVisible();
    expect(within(card).getByText("Duration 1m 05s")).toBeVisible();
    expect(within(card).getByText("Tokens 1.3K")).toBeVisible();
    expect(within(card).getByText("Created not-a-date")).toBeVisible();
    expect(within(card).getByText("Updated still-bad")).toBeVisible();
    expect(within(card).getByText("Planning (archived)")).toBeVisible();
  });

  it("keeps an honest empty state when coverage is unavailable", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(makePage([], null, { coverage: { complete: false, unavailableThreads: 1 } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    expect(
      await screen.findByText("No run history available. Some conversations could not be scanned."),
    ).toBeVisible();
    expect(
      screen.getByText("Run history is incomplete: 1 conversation could not be scanned."),
    ).toBeVisible();
  });

  it("keeps duplicate run ids across different threads as separate rows", async () => {
    const first = makeItem(makeRun("run-shared"), {
      threadName: "Planning",
      threadArchived: false,
    });
    const second = makeItem(
      makeRun("run-shared", { threadId: "thread-archived", agentId: "agent-a" }),
      { threadName: "Archive", threadArchived: true },
    );
    const fetchMock = vi.fn(async () => jsonResponse(makePage([first, second])));
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    expect(
      await screen.findByRole("button", { name: "Open run: Planner in #Planning" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open run: Planner in #Archive" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Attempt 1")).toHaveLength(2);
  });

  it("opens the returned run item on click and on keyboard activation", async () => {
    const user = userEvent.setup();
    const onOpenRun = vi.fn();
    const item = makeItem(makeRun("run-click", { agentId: "agent-a" }));
    const fetchMock = vi.fn(async () => jsonResponse(makePage([item])));
    vi.stubGlobal("fetch", fetchMock);
    renderView({ onOpenRun });

    const open = await screen.findByRole("button", {
      name: "Open run: Planner in #Planning",
    });
    await user.click(open);
    expect(onOpenRun).toHaveBeenCalledWith(item);

    open.focus();
    await user.keyboard("{Enter}");
    expect(onOpenRun).toHaveBeenCalledTimes(2);
    expect(onOpenRun).toHaveBeenLastCalledWith(item);
  });
});
