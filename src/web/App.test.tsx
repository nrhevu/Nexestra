// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRun,
  AgentView,
  BootstrapData,
  KnowledgeDocument,
  RunHistoryPage,
  Thread,
  ThreadData,
  ThreadHistoryPage,
  WorkspaceActivityData,
} from "../shared/contracts.js";
import { runAttentionItem } from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-02T12:00:00.000Z";

function formatDateTimeForTest(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const workspace = {
  id: "workspace-nexestra",
  name: "Nexestra",
  slug: "nexestra",
  createdAt: now,
  updatedAt: now,
};

const workerAgent: AgentView = {
  id: "agent-planner",
  workspaceId: workspace.id,
  kind: "worker",
  name: "Planner",
  handle: "planner",
  description: "Plans work",
  instructions: "",
  enabled: true,
  archived: false,
  harness: "codex",
  createdAt: now,
  updatedAt: now,
  readiness: "ready",
  readinessLabel: "Ready",
};

const bootstrapData: BootstrapData = {
  workspaces: [workspace],
  workspace,
  agents: [],
  threads: [],
  tasks: [],
  knowledge: [],
  assignments: [],
  activeRuns: [],
  attention: [],
  runtime: {
    chatgpt: { installed: true, connected: true, message: "Connected." },
    harnesses: {
      codex: { installed: true, version: "codex 1.0" },
      opencode: { installed: true, version: "opencode 1.0" },
    },
  },
  workspacePath: "/workspace",
  dataPath: "/workspace/.nexestra",
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function activityThread(id: string, name: string): Thread {
  return {
    id,
    name,
    slug: name,
    workspaceId: workspace.id,
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    lastMessageAt: now,
    archived: false,
  };
}

function activityRun(thread: Thread, status: AgentRun["status"] = "running"): AgentRun {
  return {
    id: `run-${thread.id}`,
    threadId: thread.id,
    triggerMessageId: "trigger",
    agentId: workerAgent.id,
    attempt: 1,
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function historyUrl(thread: Pick<Thread, "id" | "workspaceId">, around?: string): string {
  const query = new URLSearchParams({ workspaceId: thread.workspaceId, limit: "50" });
  if (around) query.set("around", around);
  return `/api/threads/${encodeURIComponent(thread.id)}/history?${query}`;
}

// These existing acceptance fixtures fit in one page. Pagination/race cases have separate fixtures.
function historySnapshot(snapshot: ThreadData): ThreadHistoryPage {
  return {
    ...snapshot,
    activeRuns: snapshot.runs.filter((run) =>
      ["queued", "running", "waiting_approval", "waiting_input"].includes(run.status),
    ),
    page: {
      totalMessages: snapshot.messages.length,
      totalArtifacts: snapshot.artifacts.length,
      firstMessageIndex: snapshot.messages.length ? 1 : 0,
      lastMessageIndex: snapshot.messages.length,
      beforeCursor: null,
      afterCursor: null,
    },
  };
}

function threadSnapshot(thread: Thread, runs: AgentRun[]): ThreadHistoryPage {
  return historySnapshot({ thread, runs, messages: [], artifacts: [], toolCalls: [] });
}

function installActivityTimers() {
  let nextId = 0;
  const callbacks = new Map<number, () => void>();
  const intervals = vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
    const id = ++nextId;
    if (typeof handler === "function" && delay === 1_000) callbacks.set(id, handler);
    return id as unknown as ReturnType<typeof window.setInterval>;
  });
  vi.spyOn(window, "clearInterval").mockImplementation((id) => {
    callbacks.delete(Number(id));
  });
  return {
    intervals,
    callbacks,
    tick: async () => {
      await act(async () => {
        for (const callback of callbacks.values()) callback();
      });
    },
  };
}

function installEventSources() {
  const sources: MockSource[] = [];
  class MockSource {
    private readonly listeners = new Map<string, Set<EventListener>>();
    close = vi.fn();
    constructor(readonly url: string) {
      sources.push(this);
    }
    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type: string, listener: EventListener) {
      this.listeners.get(type)?.delete(listener);
    }
    emit(data: unknown) {
      const event = new MessageEvent("thread", { data: JSON.stringify(data) });
      for (const listener of this.listeners.get("thread") ?? []) listener(event);
    }
  }
  vi.stubGlobal("EventSource", MockSource);
  return sources;
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("Activity-aware refresh", () => {
  it("does not schedule background polling while the workspace is idle", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const intervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(() => 1 as unknown as ReturnType<typeof window.setInterval>);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(bootstrapData)),
    );

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });

    expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
  });

  it("polls only the active thread and refreshes bootstrap once when work finishes", async () => {
    const thread = {
      id: "thread-active",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
    };
    const run = {
      id: "run-active",
      threadId: thread.id,
      triggerMessageId: "message-trigger",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    const callbacks: { handler: () => void; delay?: number }[] = [];
    const intervalSpy = vi.spyOn(window, "setInterval").mockImplementation((handler, delay) => {
      if (typeof handler === "function") callbacks.push({ handler, delay });
      return callbacks.length as unknown as ReturnType<typeof window.setInterval>;
    });
    let threadReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [thread],
          activeRuns: [run],
        });
      }
      if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [thread],
          activeRuns: [],
        });
      }
      if (path === historyUrl(thread)) {
        threadReads += 1;
        return jsonResponse(
          threadSnapshot(thread, [{ ...run, status: threadReads === 1 ? "running" : "completed" }]),
        );
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);

    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    await waitFor(() => expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000));

    await act(async () => {
      callbacks.find((entry) => entry.delay === 1_000)?.handler();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(`/api/bootstrap?workspaceId=${workspace.id}`, {
        headers: {},
        signal: expect.any(AbortSignal),
      });
    });

    expect(threadReads).toBe(2);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/bootstrap")),
    ).toHaveLength(2);
  });

  it("renders live response events and does not poll an EventSource-backed thread", async () => {
    const thread = {
      id: "thread-stream",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
    };
    const run = {
      id: "run-stream",
      threadId: thread.id,
      triggerMessageId: "message-stream",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    const transcript: ThreadData = {
      thread,
      messages: [
        {
          id: "message-stream",
          threadId: thread.id,
          sequence: 1,
          author: { kind: "user", id: "local-user", name: "You" },
          content: "@planner stream",
          mentions: [{ agentId: workerAgent.id, handle: workerAgent.handle }],
          knowledgeReferences: [],
          artifactIds: [],
          createdAt: now,
        },
      ],
      artifacts: [],
      runs: [run],
      toolCalls: [
        {
          id: "tool-stream",
          runId: run.id,
          threadId: thread.id,
          agentId: workerAgent.id,
          name: "read",
          permission: "read",
          status: "completed",
          input: '{"filePath":"README.md"}',
          summary: "Read README.md",
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    let currentTranscript = transcript;
    const sources: MockEventSource[] = [];
    class MockEventSource {
      private readonly listeners = new Map<string, Set<EventListener>>();

      constructor(readonly url: string) {
        sources.push(this);
      }

      addEventListener(type: string, listener: EventListener) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: EventListener) {
        this.listeners.get(type)?.delete(listener);
      }

      close() {}

      emit(type: string, data: unknown) {
        const event = new MessageEvent(type, { data: JSON.stringify(data) });
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.stubGlobal("EventSource", MockEventSource);
    const intervalSpy = vi.spyOn(window, "setInterval");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/bootstrap") {
          return jsonResponse({
            ...bootstrapData,
            agents: [{ ...workerAgent, readiness: "busy", readinessLabel: "Responding" }],
            threads: [thread],
            activeRuns: [run],
          });
        }
        if (String(input) === historyUrl(thread))
          return jsonResponse(historySnapshot(currentTranscript));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    window.history.replaceState({}, "", `/threads/${thread.id}`);

    render(<App />);
    await waitFor(() => expect(sources).toHaveLength(1));
    await act(async () => {
      sources[0]?.emit("thread", {
        revision: 3,
        refresh: false,
        activities: [
          {
            runId: run.id,
            threadId: thread.id,
            agentId: workerAgent.id,
            stage: "responding",
            thinking: "**Inspecting** the relevant files.",
            text: "**Live** response",
            detail: "Writing a response",
            updatedAt: now,
          },
        ],
      });
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Streaming response")).toHaveTextContent("Live response");
    });
    const thinking = screen.getByText("Thinking").closest("details");
    expect(thinking).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("Thinking"));
    expect(thinking).toHaveAttribute("open");
    expect(await screen.findByText("Inspecting")).toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();
    expect(screen.getByText("Writing a response")).toBeInTheDocument();
    expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);

    currentTranscript = {
      ...transcript,
      messages: [
        ...transcript.messages,
        {
          id: "message-final",
          threadId: thread.id,
          sequence: 2,
          author: {
            kind: "agent",
            id: workerAgent.id,
            name: workerAgent.name,
            handle: workerAgent.handle,
          },
          content: "Final response",
          mentions: [],
          knowledgeReferences: [],
          artifactIds: [],
          triggerMessageId: "message-stream",
          createdAt: now,
        },
      ],
      runs: [{ ...run, status: "completed" }],
    };
    await act(async () => {
      sources[0]?.emit("thread", { revision: 4, refresh: true, activities: [] });
    });
    await screen.findByText("Final response");
    await waitFor(() => expect(screen.queryByText("Thinking")).not.toBeInTheDocument());
    expect(screen.queryByText("read")).not.toBeInTheDocument();
  });
});

describe("Workspace attention supervision", () => {
  it("updates a background question while the selected thread streams and opens its thread", async () => {
    const selected = activityThread("thread-selected", "current");
    const background = activityThread("thread-background", "research");
    const selectedRun = activityRun(selected);
    const backgroundRun = activityRun(background);
    const waitingRun = { ...backgroundRun, status: "waiting_input" as const };
    const pending = runAttentionItem(waitingRun, workerAgent.name, background.name);
    const timers = installActivityTimers();
    const sources = installEventSources();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [selected, background],
          activeRuns: [selectedRun, backgroundRun],
        });
      if (path === historyUrl(selected))
        return jsonResponse(threadSnapshot(selected, [selectedRun]));
      if (path === historyUrl(background, waitingRun.triggerMessageId))
        return jsonResponse(threadSnapshot(background, [waitingRun]));
      if (path.startsWith("/api/activity"))
        return jsonResponse({
          workspaceId: workspace.id,
          activeRuns: [selectedRun, waitingRun],
          attention: [pending],
        });
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${selected.id}`);
    render(<App />);
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(timers.callbacks.size).toBe(1);

    await timers.tick();
    expect(screen.getByRole("button", { name: /#research/ })).toHaveTextContent("Waiting");
    expect(screen.getByRole("button", { name: /#current/ })).toHaveTextContent("Running");
    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("1");
    expect(timers.intervals.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
    expect(await screen.findByText("Answer needed")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open run: Planner in #research" }));
    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${background.id}`);
    expect(fetchMock.mock.calls.every(([, init]) => !init || !("method" in init))).toBe(true);
  });

  it("refreshes completed work once while another background run remains and retains newer activity", async () => {
    const finished = activityThread("thread-finished", "finished");
    const ongoing = activityThread("thread-ongoing", "ongoing");
    const finishedRun = activityRun(finished);
    const ongoingRun = activityRun(ongoing);
    const waitingRun = { ...ongoingRun, status: "waiting_approval" as const };
    const pending = runAttentionItem(waitingRun, workerAgent.name, ongoing.name);
    const delayedBootstrap = deferredResponse();
    const timers = installActivityTimers();
    let bootstrapReads = 0;
    let activity: WorkspaceActivityData = {
      workspaceId: workspace.id,
      activeRuns: [ongoingRun],
      attention: [],
    };
    const initial = {
      ...bootstrapData,
      agents: [workerAgent],
      threads: [finished, ongoing],
      activeRuns: [finishedRun, ongoingRun],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        return bootstrapReads === 1 ? jsonResponse(initial) : delayedBootstrap.promise;
      }
      if (path.startsWith("/api/activity")) return jsonResponse(activity);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/attention");
    render(<App />);
    await screen.findByRole("heading", { name: "Needs attention" });

    await timers.tick();
    expect(bootstrapReads).toBe(2);
    expect(timers.callbacks.size).toBe(1);
    activity = { ...activity, activeRuns: [waitingRun], attention: pending ? [pending] : [] };
    await timers.tick();
    expect(await screen.findByText("Approval requested")).toBeVisible();
    await act(async () => {
      delayedBootstrap.resolve(
        jsonResponse({
          ...initial,
          agents: [{ ...workerAgent, name: "Updated planner" }],
          activeRuns: [ongoingRun],
        }),
      );
    });
    expect(screen.getByText("Approval requested")).toBeVisible();
    await timers.tick();
    expect(bootstrapReads).toBe(2);
    expect(timers.intervals.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Surfaces" }));
    await userEvent.click(screen.getByRole("button", { name: /Agent management/ }));
    expect(await screen.findByText("Updated planner")).toBeVisible();
  });

  it("synchronizes streamed run completion and preserves task attention for that thread", async () => {
    const selected = activityThread("thread-selected", "current");
    const background = activityThread("thread-background", "research");
    const selectedRun = activityRun(selected, "waiting_input");
    const backgroundRun = activityRun(background);
    const task = {
      id: "task-blocked",
      workspaceId: workspace.id,
      title: "Needs repository access",
      description: "",
      status: "blocked" as const,
      assigneeId: null,
      labels: [],
      threadId: selected.id,
      createdAt: now,
      updatedAt: now,
    };
    const taskAttention = {
      id: `task:${task.id}`,
      kind: "task_blocked" as const,
      title: task.title,
      detail: "Repository access is missing.",
      taskId: task.id,
      runId: selectedRun.id,
      threadId: selected.id,
      updatedAt: "2026-09-03T12:00:00.000Z",
    };
    const pending = runAttentionItem(selectedRun, workerAgent.name, selected.name);
    const initial = {
      ...bootstrapData,
      agents: [workerAgent],
      threads: [selected, background],
      tasks: [task],
      activeRuns: [selectedRun, backgroundRun],
      attention: [taskAttention, ...(pending ? [pending] : [])],
    };
    const sources = installEventSources();
    const timers = installActivityTimers();
    let transcript = threadSnapshot(selected, [selectedRun]);
    let bootstrapReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.startsWith("/api/bootstrap")) {
          bootstrapReads += 1;
          return jsonResponse(
            bootstrapReads === 1
              ? initial
              : { ...initial, activeRuns: [backgroundRun], attention: [taskAttention] },
          );
        }
        if (path === historyUrl(selected)) return jsonResponse(historySnapshot(transcript));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    window.history.replaceState({}, "", `/threads/${selected.id}`);
    render(<App />);
    await waitFor(() => expect(sources).toHaveLength(1));
    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("2");
    transcript = threadSnapshot(selected, [{ ...selectedRun, status: "completed" }]);
    await act(async () => {
      sources[0]?.emit({ revision: 2, refresh: true, activities: [] });
    });
    await waitFor(() => expect(bootstrapReads).toBe(2));
    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("1");
    expect(sources[0]?.close).toHaveBeenCalledTimes(1);
    expect(timers.callbacks.size).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
    expect(screen.getByText("Repository access is missing.")).toBeVisible();
  });

  it.each([false, true])(
    "loads an uncached attention task and guards workspace switching: %s",
    async (switchWorkspace) => {
      const thread = activityThread("thread-master", "master");
      const run = activityRun(thread);
      const nextWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
      const task = {
        id: "task-new",
        workspaceId: workspace.id,
        title: "New worker task",
        description: "Repository access is missing.",
        status: "blocked" as const,
        assigneeId: null,
        labels: [],
        threadId: thread.id,
        createdAt: now,
        updatedAt: now,
      };
      const pending = {
        id: `task:${task.id}`,
        kind: "task_failed" as const,
        title: task.title,
        detail: task.description,
        taskId: task.id,
        threadId: thread.id,
        updatedAt: now,
      };
      const delayedTask = deferredResponse();
      const timers = installActivityTimers();
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap")
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, nextWorkspace],
            threads: [thread],
            activeRuns: [run],
          });
        if (path === `/api/bootstrap?workspaceId=${nextWorkspace.id}`)
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, nextWorkspace],
            workspace: nextWorkspace,
          });
        if (path.startsWith("/api/activity"))
          return jsonResponse({
            workspaceId: workspace.id,
            activeRuns: [run],
            attention: [pending],
          });
        if (path === `/api/tasks/${task.id}`) return delayedTask.promise;
        if (path === `/api/tasks/${task.id}/process`)
          return jsonResponse({ task, assignments: [], toolCalls: [] });
        return jsonResponse({ error: { message: "Not found" } }, 404);
      });
      vi.stubGlobal("fetch", fetchMock);
      window.history.replaceState({}, "", "/surfaces/attention");
      render(<App />);
      await screen.findByRole("heading", { name: "Needs attention" });
      await timers.tick();
      await userEvent.click(screen.getByRole("button", { name: "Inspect task: New worker task" }));
      expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}`, { headers: {} });
      if (switchWorkspace) {
        await userEvent.click(screen.getByRole("button", { name: "Switch to Product" }));
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
            "aria-current",
            "page",
          ),
        );
      }
      await act(async () => {
        delayedTask.resolve(jsonResponse(task));
      });
      if (switchWorkspace) {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "Nothing needs your attention" })).toBeVisible();
      } else {
        const dialog = await screen.findByRole("dialog", { name: "New worker task" });
        expect(await within(dialog).findByText("Repository access is missing.")).toBeVisible();
        expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}/process`, { headers: {} });
      }
    },
  );

  it.each(["activity", "bootstrap", "thread"] as const)(
    "ignores a delayed %s response after switching workspaces",
    async (delayedKind) => {
      const oldThread = activityThread("thread-old", "old-thread");
      const oldRun = activityRun(oldThread);
      const productWorkspace = {
        ...workspace,
        id: "workspace-product",
        name: "Product",
        slug: "product",
      };
      const initial = {
        ...bootstrapData,
        workspaces: [workspace, productWorkspace],
        agents: [workerAgent],
        threads: [oldThread],
        activeRuns: [oldRun],
      };
      const next = {
        ...bootstrapData,
        workspaces: [workspace, productWorkspace],
        workspace: productWorkspace,
      };
      const delayed = deferredResponse();
      const timers = installActivityTimers();
      let oldBootstrapReads = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) return jsonResponse(next);
        if (path.startsWith("/api/bootstrap")) {
          oldBootstrapReads += 1;
          return oldBootstrapReads === 1 ? jsonResponse(initial) : delayed.promise;
        }
        if (path.startsWith("/api/threads")) return delayed.promise;
        if (path.startsWith("/api/activity"))
          return delayedKind === "activity"
            ? delayed.promise
            : jsonResponse({ workspaceId: workspace.id, activeRuns: [], attention: [] });
        return jsonResponse({ error: { message: "Not found" } }, 404);
      });
      vi.stubGlobal("fetch", fetchMock);
      window.history.replaceState(
        {},
        "",
        delayedKind === "thread" ? `/threads/${oldThread.id}` : "/surfaces/attention",
      );
      render(<App />);
      await screen.findByRole("button", { name: "Switch to Product" });
      if (delayedKind === "thread") {
        await waitFor(() =>
          expect(fetchMock).toHaveBeenCalledWith(historyUrl(oldThread), {
            headers: {},
            signal: expect.any(AbortSignal),
          }),
        );
      } else {
        // Wait for supervision to mount before ticking its interval, then for its async refresh.
        await waitFor(() => expect(timers.callbacks.size).toBe(1));
        await timers.tick();
        if (delayedKind === "bootstrap") await waitFor(() => expect(oldBootstrapReads).toBe(2));
      }
      await userEvent.click(screen.getByRole("button", { name: "Switch to Product" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
          "aria-current",
          "page",
        ),
      );
      const waitingRun = { ...oldRun, status: "waiting_input" as const };
      const pending = runAttentionItem(waitingRun, workerAgent.name, oldThread.name);
      await act(async () => {
        delayed.resolve(
          jsonResponse(
            delayedKind === "thread"
              ? threadSnapshot(oldThread, [waitingRun])
              : delayedKind === "bootstrap"
                ? { ...initial, activeRuns: [waitingRun], attention: [pending] }
                : { workspaceId: workspace.id, activeRuns: [waitingRun], attention: [pending] },
          ),
        );
      });
      expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("0");
      expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(productWorkspace.id);
      expect(timers.callbacks.size).toBe(0);
      await userEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
      expect(screen.getByRole("heading", { name: "Nothing needs your attention" })).toBeVisible();
    },
  );
});

describe("Workspace navigation", () => {
  it("recovers a removed saved workspace once through the default bootstrap", async () => {
    window.localStorage.setItem("nexestra.workspaceId", "workspace-removed");
    window.history.replaceState({}, "", "/surfaces/attention");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/bootstrap"
        ? jsonResponse(bootstrapData)
        : jsonResponse({ error: { code: "not_found", message: "Workspace not found." } }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("heading", { name: "Nothing needs your attention" });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/bootstrap?workspaceId=workspace-removed",
      "/api/bootstrap",
    ]);
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(workspace.id);
  });

  it("keeps an explicit workspace-switch failure visible without falling back", async () => {
    const missing = { ...workspace, id: "workspace-removed", name: "Removed" };
    window.history.replaceState({}, "", "/surfaces/attention");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/bootstrap"
        ? jsonResponse({ ...bootstrapData, workspaces: [workspace, missing] })
        : jsonResponse({ error: { code: "not_found", message: "Workspace not found." } }, 404),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Switch to Removed" }));
    expect(await screen.findByText("Workspace not found.")).toBeVisible();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/bootstrap",
      "/api/bootstrap?workspaceId=workspace-removed",
    ]);
  });

  it("uses the left rail for workspaces and creates a newly scoped workspace", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const productWorkspace = {
      id: "workspace-product",
      name: "Product Team",
      slug: "product-team",
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") return jsonResponse(bootstrapData);
      if (path === "/api/workspaces" && init?.method === "POST") {
        return jsonResponse(productWorkspace, 201);
      }
      if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          workspace: productWorkspace,
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { container } = render(<App />);

    await screen.findByRole("heading", { name: "Agent management" });
    expect(container.querySelector(".traffic-lights")).not.toBeInTheDocument();
    const workspaceRail = screen.getByRole("navigation", { name: "Workspaces" });
    expect(
      within(workspaceRail).getByRole("button", { name: "Switch to Nexestra" }),
    ).toHaveAttribute("aria-current", "page");
    const workspaceNavigation = screen.getByRole("navigation", {
      name: "Workspace navigation",
    });
    expect(within(workspaceNavigation).getByRole("button", { name: "Threads" })).toBeVisible();
    expect(within(workspaceNavigation).getByRole("button", { name: "Surfaces" })).toBeVisible();

    await user.click(within(workspaceRail).getByRole("button", { name: "Create workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Create workspace" });
    await user.type(within(dialog).getByPlaceholderText("Product team"), "Product Team");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));

    await waitFor(() => {
      expect(
        within(workspaceRail).getByRole("button", { name: "Switch to Product Team" }),
      ).toHaveAttribute("aria-current", "page");
    });
    const request = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/workspaces" && init?.method === "POST",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ name: "Product Team" });
  });
});

describe("Workspace settings", () => {
  it("renames the active workspace without losing its selection or attention state", async () => {
    const thread = activityThread("thread-waiting", "waiting");
    const run = { ...activityRun(thread), status: "waiting_input" as const };
    const pending = runAttentionItem(run, workerAgent.name, thread.name);
    window.history.replaceState({}, "", "/surfaces/attention");
    vi.spyOn(window, "setInterval").mockImplementation(
      () => 1 as unknown as ReturnType<typeof window.setInterval>,
    );
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace],
          threads: [thread],
          activeRuns: [run],
          attention: [pending],
        });
      }
      if (path === `/api/workspaces/${workspace.id}` && init?.method === "PATCH") {
        return jsonResponse({
          ...workspace,
          name: "Nexus Studio",
          slug: "nexus-studio",
          updatedAt: now,
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("Answer needed");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = screen.getByRole("dialog", { name: "Local workspace" });
    const input = within(dialog).getByRole("textbox", { name: "Rename selected workspace" });
    await user.clear(input);
    await user.type(input, "Nexus Studio");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Switch to Nexus Studio" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
    const renameCall = fetchMock.mock.calls.find(
      ([value, requestInit]) =>
        String(value) === `/api/workspaces/${workspace.id}` && requestInit?.method === "PATCH",
    );
    expect(JSON.parse(String(renameCall?.[1]?.body))).toEqual({ name: "Nexus Studio" });
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(workspace.id);
    expect(screen.getByText("Answer needed")).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([value]) => String(value).startsWith("/api/bootstrap")),
    ).toHaveLength(1);
  });

  it("reorders workspaces with accessible move controls and keeps the active workspace active", async () => {
    const productWorkspace = {
      id: "workspace-product",
      name: "Product Team",
      slug: "product-team",
      createdAt: now,
      updatedAt: now,
    };
    const thread = activityThread("thread-waiting", "waiting");
    const run = { ...activityRun(thread), status: "waiting_input" as const };
    const pending = runAttentionItem(run, workerAgent.name, thread.name);
    window.history.replaceState({}, "", "/surfaces/attention");
    vi.spyOn(window, "setInterval").mockImplementation(
      () => 1 as unknown as ReturnType<typeof window.setInterval>,
    );
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          threads: [thread],
          activeRuns: [run],
          attention: [pending],
        });
      }
      if (path === "/api/workspaces/order" && init?.method === "PUT") {
        return jsonResponse([productWorkspace, workspace]);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("Answer needed");
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = screen.getByRole("dialog", { name: "Local workspace" });
    const orderList = within(dialog).getByRole("list", { name: "Workspace order" });
    await user.click(within(orderList).getByRole("button", { name: "Move Product Team up" }));

    const rail = screen.getByRole("navigation", { name: "Workspaces" });
    await waitFor(() => {
      const buttons = within(rail).getAllByRole("button");
      expect(buttons[0]).toHaveAccessibleName("Switch to Product Team");
      expect(buttons[1]).toHaveAccessibleName("Switch to Nexestra");
      expect(within(rail).getByRole("button", { name: "Switch to Nexestra" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
    const orderCall = fetchMock.mock.calls.find(
      ([value, requestInit]) =>
        String(value) === "/api/workspaces/order" && requestInit?.method === "PUT",
    );
    expect(JSON.parse(String(orderCall?.[1]?.body))).toEqual({
      workspaceIds: [productWorkspace.id, workspace.id],
    });
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(workspace.id);
    expect(screen.getByText("Answer needed")).toBeVisible();
    expect(within(orderList).getByRole("button", { name: "Move Product Team up" })).toBeDisabled();
    expect(within(orderList).getByRole("button", { name: "Move Nexestra down" })).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([value]) => String(value).startsWith("/api/bootstrap")),
    ).toHaveLength(1);
  });

  it("shows a stale reorder error and reloads the workspace list from the server", async () => {
    const productWorkspace = {
      id: "workspace-product",
      name: "Product Team",
      slug: "product-team",
      createdAt: now,
      updatedAt: now,
    };
    window.history.replaceState({}, "", "/surfaces/attention");
    vi.spyOn(window, "setInterval").mockImplementation(
      () => 1 as unknown as ReturnType<typeof window.setInterval>,
    );
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
        });
      }
      if (path === "/api/workspaces/order" && init?.method === "PUT") {
        return jsonResponse(
          {
            error: { message: "Workspace list changed. Reload the workspace list and try again." },
          },
          409,
        );
      }
      if (path === "/api/workspaces" && init?.method === undefined) {
        return jsonResponse([productWorkspace, workspace]);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "Open settings" });
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = screen.getByRole("dialog", { name: "Local workspace" });
    const orderList = within(dialog).getByRole("list", { name: "Workspace order" });
    await user.click(within(orderList).getByRole("button", { name: "Move Product Team up" }));

    expect(await screen.findByText(/Workspace list changed/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reload workspace list" }));

    await waitFor(() => {
      expect(
        within(orderList).getByRole("button", { name: "Move Product Team up" }),
      ).toBeDisabled();
      expect(within(orderList).getByRole("button", { name: "Move Nexestra down" })).toBeDisabled();
    });
    const rail = screen.getByRole("navigation", { name: "Workspaces" });
    expect(within(rail).getAllByRole("button")[0]).toHaveAccessibleName("Switch to Product Team");
    expect(within(rail).getByRole("button", { name: "Switch to Nexestra" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(orderList).getByRole("button", { name: "Move Product Team up" })).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(([value]) => String(value) === "/api/workspaces/order"),
    ).toHaveLength(1);
  });
});

describe("Workspace export navigation", () => {
  it("opens from Settings or the command without exporting and preserves the conversation draft and files", async () => {
    const thread = activityThread("export-draft-thread", "Export draft");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread)) return jsonResponse(threadSnapshot(thread, []));
      return jsonResponse({ error: { message: "Unexpected request" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("combobox", { name: "Message" }), "Keep export draft");
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["selected bytes"], "export-context.txt"),
    );
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Export selected workspace" }));
    expect(screen.getByRole("dialog", { name: "Export workspace" })).toHaveTextContent(
      workspace.name,
    );
    expect(screen.queryByRole("dialog", { name: "Local workspace" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.type(screen.getByRole("combobox", { name: /Search/ }), "/export workspace");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Export workspace" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(window.location.pathname).toBe(`/threads/${thread.id}`);
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Keep export draft");
    expect(screen.getByText("export-context.txt")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/export"))).toBe(false);
  });

  it("cancels a pending export immediately on workspace switch and scopes the next download", async () => {
    const secondWorkspace = { ...workspace, id: "workspace-export-second", name: "Second export" };
    const firstExport = deferredResponse();
    const secondBootstrap = deferredResponse();
    const requests: { path: string; signal: AbortSignal | null | undefined }[] = [];
    const createObjectURL = vi.fn(() => "blob:stale-export");
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        if (path.includes(secondWorkspace.id)) return secondBootstrap.promise;
        return jsonResponse({ ...bootstrapData, workspaces: [workspace, secondWorkspace] });
      }
      if (path.endsWith("/export")) {
        requests.push({ path, signal: init?.signal });
        if (path.includes(secondWorkspace.id))
          return jsonResponse({ error: { message: "Second export fixture conflict" } }, 409);
        return firstExport.promise;
      }
      return jsonResponse({ error: { message: "Unexpected request" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/agents");
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("combobox", { name: /Search/ }), "/export workspace");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Download ZIP" }));
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.path).toBe(`/api/workspaces/${workspace.id}/export`);
    await user.click(screen.getByRole("button", { name: "Switch to Second export" }));
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Export workspace" })).not.toBeInTheDocument();
    // The old bootstrap is still rendered while the next workspace loads.
    await user.type(screen.getByRole("combobox", { name: /Search/ }), "/export workspace");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Export workspace" })).not.toBeInTheDocument();
    await act(async () => {
      firstExport.resolve(
        new Response("PK stale", { headers: { "Content-Type": "application/zip" } }),
      );
      secondBootstrap.resolve(
        jsonResponse({
          ...bootstrapData,
          workspace: secondWorkspace,
          workspaces: [workspace, secondWorkspace],
        }),
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Second export" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    await user.type(screen.getByRole("combobox", { name: /Search/ }), "/export workspace");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Export workspace" })).toHaveTextContent(
      secondWorkspace.name,
    );
    await user.click(screen.getByRole("button", { name: "Download ZIP" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]?.path).toBe(`/api/workspaces/${secondWorkspace.id}/export`);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/surfaces/agents");
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(
      true,
    );
  });
});

describe("Thread navigation", () => {
  it("keeps the initial idle transcript request when the selected thread is clicked again", async () => {
    const thread = activityThread("thread-reselected", "waiting");
    const pending = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      return pending.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /^#waiting/ }));
    await userEvent.click(screen.getByRole("button", { name: "Threads" }));
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      pending.resolve(jsonResponse(threadSnapshot(thread, [])));
    });
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/threads")),
    ).toHaveLength(1);
  });

  it("keeps an older thread request from replacing the selected transcript", async () => {
    const firstThread = {
      id: "thread-first",
      workspaceId: workspace.id,
      name: "First thread",
      slug: "first-thread",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
    };
    const secondThread = {
      ...firstThread,
      id: "thread-second",
      name: "Second thread",
      slug: "second-thread",
    };
    const transcript = (thread: typeof firstThread, content: string): ThreadHistoryPage =>
      historySnapshot({
        thread,
        messages: [
          {
            id: `message-${thread.id}`,
            threadId: thread.id,
            sequence: 1,
            author: { kind: "user", id: "local-user", name: "You" },
            content,
            mentions: [],
            knowledgeReferences: [],
            artifactIds: [],
            createdAt: now,
          },
        ],
        artifacts: [],
        runs: [],
        toolCalls: [],
      });
    let firstReads = 0;
    let resolveOlderReload: (response: Response) => void = () => undefined;
    let resolveSecond: (response: Response) => void = () => undefined;
    const olderReload = new Promise<Response>((resolve) => {
      resolveOlderReload = resolve;
    });
    const secondLoad = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, threads: [firstThread, secondThread] });
      }
      if (path === `/api/threads/${firstThread.id}/messages` && init?.method === "POST") {
        return jsonResponse({ message: {}, runs: [] }, 201);
      }
      if (path === historyUrl(firstThread)) {
        firstReads += 1;
        return firstReads === 1
          ? jsonResponse(transcript(firstThread, "First transcript"))
          : olderReload;
      }
      if (path === historyUrl(secondThread)) return secondLoad;
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${firstThread.id}`);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("First transcript");
    await user.type(screen.getByRole("combobox", { name: "Message" }), "Save this note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(firstReads).toBe(2));
    await user.click(screen.getByRole("button", { name: /Second thread/ }));

    expect(screen.getByText("Loading transcript…")).toBeVisible();
    expect(screen.queryByText("First transcript")).not.toBeInTheDocument();

    await act(async () => {
      resolveSecond(jsonResponse(transcript(secondThread, "Second transcript")));
    });
    await screen.findByText("Second transcript");
    await act(async () => {
      resolveOlderReload(jsonResponse(transcript(firstThread, "Stale first transcript")));
    });

    await waitFor(() => expect(screen.getByText("Second transcript")).toBeVisible());
    expect(screen.queryByText("Stale first transcript")).not.toBeInTheDocument();
  });
});

describe("Last thread per workspace", () => {
  it("remembers the last thread and lets an explicit URL take precedence", async () => {
    const user = userEvent.setup();
    const first = activityThread("thread-last-first", "general");
    const second = activityThread("thread-last-second", "notes");
    window.history.replaceState({}, "", `/threads/${second.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [first, second] });
        }
        if (path === historyUrl(first)) {
          return jsonResponse(threadSnapshot(first, []));
        }
        if (path === historyUrl(second)) {
          return jsonResponse(threadSnapshot(second, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${second.id}`);
    expect(window.localStorage.getItem(`nexestra.lastThread.${workspace.id}`)).toBe(second.id);

    await user.click(screen.getByRole("button", { name: /#general/ }));
    await waitFor(() =>
      expect(window.localStorage.getItem(`nexestra.lastThread.${workspace.id}`)).toBe(first.id),
    );

    act(() => {
      window.history.replaceState({}, "", `/threads/${second.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue(""));
    expect(window.location.pathname).toBe(`/threads/${second.id}`);
    expect(window.localStorage.getItem(`nexestra.lastThread.${workspace.id}`)).toBe(second.id);
  });

  it("restores the last thread on reload and returns to it from any surface", async () => {
    const user = userEvent.setup();
    const first = activityThread("thread-relaid-first", "general");
    const second = activityThread("thread-relaid-second", "notes");
    window.localStorage.setItem(`nexestra.lastThread.${workspace.id}`, second.id);
    window.history.replaceState({}, "", "/surfaces/agents");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [first, second] });
        }
        if (path === historyUrl(second)) {
          return jsonResponse(threadSnapshot(second, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Threads" }));
    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${second.id}`);
    expect(window.localStorage.getItem(`nexestra.lastThread.${workspace.id}`)).toBe(second.id);
  });

  it("falls back to the remembered thread when the URL names a missing thread", async () => {
    const first = activityThread("thread-fallback-first", "general");
    const second = activityThread("thread-fallback-second", "notes");
    window.localStorage.setItem(`nexestra.lastThread.${workspace.id}`, second.id);
    window.history.replaceState({}, "", "/threads/thread-vanished");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [first, second] });
        }
        if (path === historyUrl(second)) {
          return jsonResponse(threadSnapshot(second, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${second.id}`);
  });

  it("resolves a bare foreign thread deep link by looking up the thread once", async () => {
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const deep = { ...activityThread("thread-deep", "notes"), workspaceId: productWorkspace.id };
    const local = activityThread("thread-local", "general");
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.localStorage.setItem(`nexestra.lastThread.${workspace.id}`, local.id);
    window.history.replaceState({}, "", `/threads/${deep.id}`);
    let deepReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            threads: [local],
          });
        }
        if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            workspace: productWorkspace,
            threads: [deep],
          });
        }
        if (path === `/api/threads/${deep.id}/metadata`) {
          deepReads += 1;
          return jsonResponse(deep);
        }
        if (path === historyUrl(deep)) {
          deepReads += 1;
          return jsonResponse(threadSnapshot(deep, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${deep.id}`);
    expect(window.location.search).toBe("");
    expect(window.localStorage.getItem(`nexestra.lastThread.${productWorkspace.id}`)).toBe(deep.id);
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(productWorkspace.id);
    expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(deepReads).toBe(2);
  });

  it("restores the foreign thread when navigating back after popstate", async () => {
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const deep = { ...activityThread("thread-deep", "notes"), workspaceId: productWorkspace.id };
    const local = activityThread("thread-local", "general");
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.localStorage.setItem(`nexestra.lastThread.${workspace.id}`, local.id);
    window.history.replaceState({}, "", `/threads/${local.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            threads: [local],
          });
        }
        if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            workspace: productWorkspace,
            threads: [deep],
          });
        }
        if (path === `/api/threads/${local.id}/metadata`) return jsonResponse(local);
        if (path === `/api/threads/${deep.id}/metadata`) return jsonResponse(deep);
        if (path === historyUrl(local)) return jsonResponse(threadSnapshot(local, []));
        if (path === historyUrl(deep)) return jsonResponse(threadSnapshot(deep, []));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByRole("combobox", { name: "Message" });
    act(() => {
      window.history.replaceState({}, "", `/threads/${deep.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(window.location.pathname).toBe(`/threads/${deep.id}`);

    act(() => {
      window.history.replaceState({}, "", `/threads/${local.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Nexestra" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(window.location.pathname).toBe(`/threads/${local.id}`);
  });

  it("does not repeat the foreign lookup when a background refresh replaces metadata", async () => {
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const deep = {
      ...activityThread("thread-no-repeat", "notes"),
      workspaceId: productWorkspace.id,
    };
    const local = activityThread("thread-local", "general");
    const timers = installActivityTimers();
    const pending = deferredResponse();
    let lookups = 0;
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", `/threads/${deep.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            threads: [local],
            activeRuns: [activityRun(local)],
          });
        }
        if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            workspace: productWorkspace,
            threads: [deep],
          });
        }
        if (path.startsWith("/api/activity")) {
          return jsonResponse({
            workspaceId: workspace.id,
            activeRuns: [activityRun(local)],
            attention: [],
          });
        }
        if (path === `/api/threads/${deep.id}/metadata`) {
          lookups += 1;
          return pending.promise;
        }
        if (path === historyUrl(deep)) {
          lookups += 1;
          return jsonResponse(threadSnapshot(deep, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByText("general");
    await act(async () => {});
    expect(lookups).toBe(1);

    await timers.tick();
    await act(async () => {});
    // A background activity refresh replaced `data` while the lookup was in flight; the
    // intent guard must keep it a single request rather than restarting the lookup.
    expect(lookups).toBe(1);

    await act(async () => {
      pending.resolve(jsonResponse(deep));
    });
    await act(async () => {});
    await screen.findByRole("heading", { name: "# notes" });
    expect(lookups).toBe(2);
    expect(window.location.pathname).toBe(`/threads/${deep.id}`);
  });

  it("ignores a delayed foreign lookup after a manual workspace switch", async () => {
    const user = userEvent.setup();
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const analyticsWorkspace = { ...workspace, id: "workspace-analytics", name: "Analytics" };
    const deep = { ...activityThread("thread-delayed", "notes"), workspaceId: productWorkspace.id };
    const local = activityThread("thread-local", "general");
    const analytics = {
      ...activityThread("thread-analytics", "general"),
      workspaceId: analyticsWorkspace.id,
    };
    const pending = deferredResponse();
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", `/threads/${deep.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace, analyticsWorkspace],
            threads: [local],
          });
        }
        if (path === `/api/bootstrap?workspaceId=${analyticsWorkspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace, analyticsWorkspace],
            workspace: analyticsWorkspace,
            threads: [analytics],
          });
        }
        if (path === `/api/threads/${deep.id}/metadata`) return pending.promise;
        if (path === historyUrl(local)) return jsonResponse(threadSnapshot(local, []));
        if (path === historyUrl(analytics)) {
          return jsonResponse(threadSnapshot(analytics, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByRole("button", { name: "Switch to Analytics" });
    await user.click(screen.getByRole("button", { name: "Switch to Analytics" }));
    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${analytics.id}`);

    await act(async () => {
      pending.resolve(jsonResponse(deep));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.pathname).toBe(`/threads/${analytics.id}`);
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(analyticsWorkspace.id);
    expect(screen.getByRole("button", { name: "Switch to Analytics" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("keeps a manually selected workspace while on a surface and opens its threads", async () => {
    const user = userEvent.setup();
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const local = activityThread("thread-surface-local", "general");
    const product = {
      ...activityThread("thread-surface-product", "notes"),
      workspaceId: productWorkspace.id,
    };
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/agents");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            threads: [local],
          });
        }
        if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, productWorkspace],
            workspace: productWorkspace,
            threads: [product],
          });
        }
        if (path === historyUrl(product)) {
          return jsonResponse(threadSnapshot(product, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    const first = render(<App />);

    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Switch to Product" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(window.location.pathname).toBe("/surfaces/agents");
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(productWorkspace.id);

    await user.click(screen.getByRole("button", { name: "Threads" }));
    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${product.id}`);
    first.unmount();

    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    expect(window.location.pathname).toBe(`/threads/${product.id}`);
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(productWorkspace.id);
  });
});

describe("Workspace switch during send", () => {
  it("does not let the previous workspace response overwrite the new workspace", async () => {
    const user = userEvent.setup();
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const first = activityThread("thread-send-old", "general");
    const second = {
      ...activityThread("thread-send-new", "notes"),
      workspaceId: productWorkspace.id,
    };
    const pending = deferredResponse();
    let oldThreadReads = 0;
    window.history.replaceState({}, "", `/threads/${first.id}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap" || path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          threads: [first],
        });
      }
      if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          workspace: productWorkspace,
          threads: [second],
        });
      }
      if (path === `/api/threads/${first.id}/messages` && init?.method === "POST") {
        return pending.promise;
      }
      if (path === historyUrl(first)) {
        oldThreadReads += 1;
        return jsonResponse(threadSnapshot(first, []));
      }
      if (path === historyUrl(second)) {
        return jsonResponse(threadSnapshot(second, []));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    let composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Old workspace note");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(screen.getByRole("button", { name: "Switch to Product" }));
    composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue("");
    await user.type(composer, "New workspace note");

    const bootstrapCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/bootstrap"));
    await act(async () => {
      pending.resolve(jsonResponse({ message: {}, runs: [] }, 201));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await waitFor(() => expect(bootstrapCalls()).toHaveLength(2));
    expect(oldThreadReads).toBe(1);
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("New workspace note");
    expect(window.localStorage.getItem(`nexestra.lastThread.${productWorkspace.id}`)).toBe(
      second.id,
    );
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${first.id}`)).toBe("");
    expect(window.localStorage.getItem(`nexestra.draft.${productWorkspace.id}:${second.id}`)).toBe(
      "New workspace note",
    );
  });
});

describe("Knowledge surface", () => {
  it("lists #references and uploads a document into the active workspace", async () => {
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const knowledge = {
      id: "knowledge-architecture",
      workspaceId: workspace.id,
      kind: "document" as const,
      name: "Architecture guide",
      handle: "architecture",
      description: "Repository conventions",
      fileName: "architecture.md",
      mediaType: "text/markdown",
      size: 128,
      storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-architecture/document",
      revisions: [
        {
          id: "rev-1",
          createdAt: now,
          fileName: "architecture.md",
          mediaType: "text/markdown",
          size: 128,
          storagePath:
            "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-1",
          sha256: "abc",
        },
      ],
      currentRevisionId: "rev-1",
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, knowledge: [knowledge] });
      if (path === "/api/knowledge/documents" && init?.method === "POST") {
        return jsonResponse(knowledge, 201);
      }
      if (path === `/api/knowledge/${knowledge.id}` && init?.method === "PATCH") {
        return jsonResponse({ ...knowledge, name: "System architecture" });
      }
      if (path === `/api/knowledge/${knowledge.id}/revisions`) {
        return jsonResponse({
          currentRevisionId: knowledge.currentRevisionId,
          revisions: [...knowledge.revisions].reverse(),
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    expect(screen.getByText("#architecture")).toBeVisible();
    expect(screen.getByRole("link", { name: /Download/ })).toHaveAttribute(
      "href",
      `/api/knowledge/${knowledge.id}/content`,
    );
    await user.click(screen.getByRole("button", { name: `View details for ${knowledge.name}` }));
    const details = screen.getByRole("dialog", { name: knowledge.name });
    expect(within(details).getByText("#architecture")).toBeVisible();
    expect(within(details).getByText("Repository conventions")).toBeVisible();
    await user.click(within(details).getByRole("button", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: `Edit ${knowledge.name}` });
    const nameInput = within(editDialog).getByRole("textbox", { name: "Name" });
    await user.clear(nameInput);
    await user.type(nameInput, "System architecture");
    await user.click(within(editDialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === `/api/knowledge/${knowledge.id}` && init?.method === "PATCH",
      );
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
        name: "System architecture",
        handle: "architecture",
      });
    });
    await user.click(screen.getByRole("button", { name: "Add knowledge" }));
    const dialog = screen.getByRole("dialog", { name: "Add knowledge" });
    await user.type(within(dialog).getByPlaceholderText("Architecture guide"), "Product notes");
    const fileInput = dialog.querySelector<HTMLInputElement>('input[name="file"]');
    if (!fileInput) throw new Error("expected knowledge file input");
    await user.upload(fileInput, new File(["# Notes"], "notes.md", { type: "text/markdown" }));
    expect(fileInput.files).toHaveLength(1);
    expect([...dialog.querySelectorAll(":invalid")].map((element) => element.outerHTML)).toEqual(
      [],
    );
    await user.click(within(dialog).getByRole("button", { name: "Upload document" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === "/api/knowledge/documents" && init?.method === "POST",
      );
      expect(request?.[1]?.body).toBeInstanceOf(FormData);
      const body = request?.[1]?.body as FormData;
      expect(body.get("workspaceId")).toBe(workspace.id);
      expect(body.get("handle")).toBe("product-notes");
      expect((body.get("file") as File).name).toBe("notes.md");
    });
  });

  it("deletes knowledge from its detail view", async () => {
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const knowledge = {
      id: "knowledge-notes",
      workspaceId: workspace.id,
      kind: "document" as const,
      name: "Product notes",
      handle: "product-notes",
      description: "",
      fileName: "notes.md",
      mediaType: "text/markdown",
      size: 32,
      storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-notes/document",
      revisions: [],
      currentRevisionId: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [knowledge] });
      }
      if (path === `/api/knowledge/${knowledge.id}` && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (path === `/api/knowledge/${knowledge.id}/revisions`) {
        return jsonResponse({ currentRevisionId: undefined, revisions: [] });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: `View details for ${knowledge.name}` }),
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = screen.getByRole("dialog", { name: `Delete ${knowledge.name}?` });
    await user.click(within(confirmation).getByRole("button", { name: "Delete knowledge" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input) === `/api/knowledge/${knowledge.id}` && init?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });

  it("replaces a document file and restores a prior version from the detail view", async () => {
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const later = "2026-09-03T14:00:00.000Z";
    const revisionOne = {
      id: "rev-1",
      createdAt: now,
      fileName: "architecture.md",
      mediaType: "text/markdown",
      size: 17,
      storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-1",
      sha256: "old-hash",
    };
    const revisionTwo = {
      id: "rev-2",
      createdAt: later,
      fileName: "architecture-v2.md",
      mediaType: "text/markdown",
      size: 17,
      storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-2",
      sha256: "new-hash",
    };
    let current: KnowledgeDocument = {
      id: "knowledge-architecture",
      workspaceId: workspace.id,
      kind: "document" as const,
      name: "Architecture guide",
      handle: "architecture",
      description: "",
      fileName: revisionTwo.fileName,
      mediaType: revisionTwo.mediaType,
      size: revisionTwo.size,
      storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-architecture/document",
      revisions: [revisionOne, revisionTwo],
      currentRevisionId: "rev-2",
      createdAt: now,
      updatedAt: later,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, knowledge: [current] });
      if (path === `/api/knowledge/${current.id}/revisions`) {
        return jsonResponse({
          currentRevisionId: current.currentRevisionId,
          revisions: [...current.revisions].reverse(),
        });
      }
      if (path === `/api/knowledge/${current.id}/document` && init?.method === "PUT") {
        const form = init.body as FormData;
        expect(form.get("expectedRevisionId")).toBe("rev-2");
        const file = form.get("file") as File;
        current = {
          ...current,
          fileName: file.name,
          mediaType: file.type,
          size: file.size,
          currentRevisionId: "rev-3",
          revisions: [
            ...current.revisions,
            {
              id: "rev-3",
              createdAt: later,
              fileName: file.name,
              mediaType: file.type,
              size: file.size,
              storagePath:
                "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-3",
              sha256: "replacement-hash",
            },
          ],
          updatedAt: later,
        };
        return jsonResponse(current);
      }
      if (path.endsWith("/revisions/rev-1/restore") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { expectedRevisionId: string };
        expect(body.expectedRevisionId).toBe("rev-3");
        current = {
          ...current,
          fileName: revisionOne.fileName,
          mediaType: revisionOne.mediaType,
          size: revisionOne.size,
          currentRevisionId: "rev-4",
          revisions: [
            ...current.revisions,
            {
              id: "rev-4",
              createdAt: later,
              fileName: revisionOne.fileName,
              mediaType: revisionOne.mediaType,
              size: revisionOne.size,
              storagePath:
                "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-4",
              sha256: revisionOne.sha256,
              restoredFromId: "rev-1",
            },
          ],
          updatedAt: later,
        };
        return jsonResponse(current);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: `View details for ${current.name}` }),
    );
    const details = screen.getByRole("dialog", { name: current.name });
    expect(await within(details).findByText("Version history")).toBeVisible();
    expect(
      within(details).getByRole("link", { name: `Download ${revisionTwo.fileName}` }),
    ).toHaveAttribute("href", `/api/knowledge/${current.id}/revisions/${revisionTwo.id}/content`);
    const replacementInput = within(details).getByLabelText("Replacement file");
    await user.upload(
      replacementInput,
      new File(["# Architecture v3"], "architecture-v3.md", { type: "text/markdown" }),
    );
    await user.click(within(details).getByRole("button", { name: "Replace" }));
    await within(details).findByRole("button", { name: "Current architecture-v3.md" });

    await user.click(
      within(details).getByRole("button", { name: `Restore ${revisionOne.fileName}` }),
    );
    await within(details).findByRole("button", { name: `Current ${revisionOne.fileName}` });
    expect(
      fetchMock.mock.calls.some(
        ([input, request]) =>
          String(input).endsWith("/revisions/rev-1/restore") && request?.method === "POST",
      ),
    ).toBe(true);
  });

  it("shows a replace error when the document changed before the request", async () => {
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const knowledge = {
      id: "knowledge-architecture",
      workspaceId: workspace.id,
      kind: "document" as const,
      name: "Architecture guide",
      handle: "architecture",
      description: "",
      fileName: "architecture.md",
      mediaType: "text/markdown",
      size: 17,
      storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-architecture/document",
      revisions: [
        {
          id: "rev-1",
          createdAt: now,
          fileName: "architecture.md",
          mediaType: "text/markdown",
          size: 17,
          storagePath:
            "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-1",
          sha256: "old-hash",
        },
      ],
      currentRevisionId: "rev-1",
      createdAt: now,
      updatedAt: now,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.startsWith("/api/bootstrap"))
          return jsonResponse({ ...bootstrapData, knowledge: [knowledge] });
        if (path === `/api/knowledge/${knowledge.id}/revisions`) {
          return jsonResponse({
            currentRevisionId: knowledge.currentRevisionId,
            revisions: [...knowledge.revisions].reverse(),
          });
        }
        if (path === `/api/knowledge/${knowledge.id}/document` && init?.method === "PUT") {
          return jsonResponse(
            { error: { code: "conflict", message: "This document changed since it was loaded." } },
            409,
          );
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: `View details for ${knowledge.name}` }),
    );
    const details = screen.getByRole("dialog", { name: knowledge.name });
    await within(details).findByText("Version history");
    await user.upload(
      within(details).getByLabelText("Replacement file"),
      new File(["# Architecture v2"], "architecture-v2.md", { type: "text/markdown" }),
    );
    await user.click(within(details).getByRole("button", { name: "Replace" }));
    expect(
      await within(details).findByText("This document changed since it was loaded."),
    ).toBeVisible();
  });

  it("offers workspace knowledge when the composer receives a #reference", async () => {
    const thread = {
      id: "thread-knowledge",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastMessageAt: null,
      archived: false,
    };
    const repository = {
      id: "knowledge-product",
      workspaceId: workspace.id,
      kind: "repository" as const,
      name: "Product repository",
      handle: "product-repo",
      description: "",
      source: "https://github.com/example/product.git",
      storagePath: "workspaces/workspace-nexestra/repositories/knowledge-product/source",
      status: "ready" as const,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread], knowledge: [repository] });
        }
        if (path === historyUrl(thread)) {
          return jsonResponse(threadSnapshot(thread, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Review #prod");
    expect(screen.getByRole("listbox", { name: "Choose knowledge" })).toBeVisible();
    await user.keyboard("{Enter}");
    expect(composer).toHaveValue("Review #product-repo ");
  });
});

describe("Worker creation", () => {
  it("submits an OpenCode model and provider-specific reasoning variant", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") return jsonResponse(bootstrapData);
      if (path === "/api/agents" && init?.method === "POST") return jsonResponse({}, 201);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    const dialog = screen.getByRole("dialog", { name: "Create agent" });
    await user.click(within(dialog).getByRole("radio", { name: /OpenCode/ }));
    expect(
      within(dialog).getByText("Use provider/model; leave blank to use the OpenCode default."),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByPlaceholderText("Codex Builder"), "OpenCode Planner");
    await user.type(within(dialog).getByRole("textbox", { name: "Worker model" }), "openai/gpt-5");
    await user.type(
      within(dialog).getByRole("combobox", { name: "OpenCode model variant" }),
      "high",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create agent" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input) === "/api/agents" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const request = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/agents" && init?.method === "POST",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      workspaceId: workspace.id,
      kind: "worker",
      name: "OpenCode Planner",
      handle: "opencode-planner",
      description: "",
      instructions: "",
      harness: "opencode",
      model: "openai/gpt-5",
      reasoningEffort: "high",
    });
  });
});

describe("Taskboard Worker process", () => {
  it("opens a task card and shows its live Worker activity and tool calls", async () => {
    window.history.replaceState({}, "", "/surfaces/taskboard");
    vi.spyOn(window, "setInterval").mockImplementation(
      () => 1 as unknown as ReturnType<typeof window.setInterval>,
    );
    const thread = {
      id: "thread-task",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
    };
    const task = {
      id: "task-build",
      workspaceId: workspace.id,
      title: "Build the repository feature",
      description: "Implement and test the requested change.",
      status: "in_progress" as const,
      assigneeId: workerAgent.id,
      threadId: thread.id,
      verificationCommand: "pnpm test",
      createdAt: now,
      updatedAt: now,
    };
    const repository = {
      id: "repository-product",
      workspaceId: workspace.id,
      kind: "repository" as const,
      name: "Product repository",
      handle: "product-repo",
      description: "",
      source: "https://github.com/example/product.git",
      storagePath: "workspaces/workspace-nexestra/repositories/product/source",
      status: "ready" as const,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    };
    const assignment = {
      id: "assignment-task",
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: workerAgent.id,
      repositoryId: repository.id,
      status: "running" as const,
      branch: "nexestra/assignment-task",
      worktreePath: "workspaces/workspace-nexestra/worktrees/assignment-task",
      verificationOutput: "all tests passed",
      verificationExitCode: 0,
      createdAt: now,
      updatedAt: now,
    };
    const run = {
      id: assignment.id,
      threadId: thread.id,
      triggerMessageId: "message-task",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running" as const,
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [thread],
          tasks: [task],
          knowledge: [repository],
          assignments: [assignment],
        });
      }
      if (path === `/api/tasks/${task.id}/process`) {
        return jsonResponse({
          task,
          assignment,
          run,
          activity: {
            runId: run.id,
            threadId: thread.id,
            agentId: workerAgent.id,
            stage: "tool",
            thinking: "**Inspecting** the repository.",
            text: "Implementing the change…",
            detail: "Using read",
            updatedAt: now,
          },
          toolCalls: [
            {
              id: "tool-read",
              runId: run.id,
              threadId: thread.id,
              agentId: workerAgent.id,
              name: "read",
              permission: "read",
              status: "completed",
              input: '{"filePath":"README.md"}',
              summary: "Read README.md",
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
      }
      if (path === `/api/tasks/${task.id}/stop` && init?.method === "POST") {
        return jsonResponse({
          task: { ...task, status: "todo", assigneeId: null },
          assignment: {
            ...assignment,
            status: "interrupted",
            error: "Worker process stopped by the user.",
          },
          run: {
            ...run,
            status: "interrupted",
            error: "Worker process stopped by the user.",
          },
          toolCalls: [],
        });
      }
      if (path === `/api/assignments/${assignment.id}/cleanup` && init?.method === "POST") {
        return jsonResponse({
          ...assignment,
          status: "interrupted" as const,
          worktreeCleanedAt: now,
        });
      }
      if (path === `/api/assignments/${assignment.id}/branch` && init?.method === "POST") {
        return jsonResponse({
          ...assignment,
          status: "interrupted" as const,
          worktreeCleanedAt: now,
          branchDeletedAt: now,
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: `Open process for ${task.title}` }));

    const dialog = await screen.findByRole("dialog", { name: task.title });
    expect(within(dialog).getByText("@planner")).toBeVisible();
    expect(within(dialog).getByText("#product-repo")).toBeVisible();
    expect(within(dialog).getByText("Exit 0")).toBeVisible();
    expect(within(dialog).getByText("pnpm test")).toBeVisible();
    expect(within(dialog).getByText("all tests passed")).toBeVisible();
    expect(within(dialog).getByText("Using read")).toBeVisible();
    expect(within(dialog).getByText("read")).toBeVisible();
    expect(within(dialog).getByText("Implementing the change…")).toBeVisible();
    await user.click(within(dialog).getByText("Thinking"));
    expect(await within(dialog).findByText("Inspecting")).toBeVisible();
    const cleanupButton = within(dialog).getByTitle("Remove this finished worktree");
    const deleteBranchButton = within(dialog).getByTitle(
      "Remove the worktree before deleting this branch",
    );
    expect(deleteBranchButton).toBeDisabled();
    expect(cleanupButton).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Stop process" }));
    expect(await within(dialog).findByText("Worker process stopped")).toBeVisible();
    expect(cleanupButton).toBeEnabled();
    await user.click(cleanupButton);
    expect(await within(dialog).findByText(`Removed ${formatDateTimeForTest(now)}`)).toBeVisible();
    expect(within(dialog).getByTitle("Open worktree")).toBeDisabled();
    expect(within(dialog).getByTitle("Delete branch if merged")).toBeEnabled();
    await user.click(within(dialog).getByTitle("Delete branch if merged"));
    expect(await within(dialog).findByText(`Deleted ${formatDateTimeForTest(now)}`)).toBeVisible();
    expect(within(dialog).getByTitle("Branch already deleted")).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `/api/tasks/${task.id}/stop` && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("shows blocked tasks and their failed verification output", async () => {
    window.history.replaceState({}, "", "/surfaces/taskboard");
    const task = {
      id: "task-blocked",
      workspaceId: workspace.id,
      title: "Fix the failing build",
      description: "Repair the repository build.",
      status: "blocked" as const,
      assigneeId: workerAgent.id,
      threadId: null,
      verificationCommand: "pnpm test",
      createdAt: now,
      updatedAt: now,
    };
    const assignment = {
      id: "assignment-blocked",
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: "thread-blocked",
      masterRunId: "run-master",
      workerAgentId: workerAgent.id,
      repositoryId: "repository-product",
      status: "completed" as const,
      branch: "nexestra/assignment-blocked",
      worktreePath: "workspaces/workspace-nexestra/worktrees/assignment-blocked",
      verificationOutput: "1 failed test",
      verificationExitCode: 42,
      createdAt: now,
      updatedAt: now,
    };
    const repository = {
      id: "repository-product",
      workspaceId: workspace.id,
      kind: "repository" as const,
      name: "Product repository",
      handle: "product-repo",
      description: "",
      source: "https://github.com/example/product.git",
      storagePath: "workspaces/workspace-nexestra/repositories/product/source",
      status: "ready" as const,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          tasks: [task],
          knowledge: [repository],
          assignments: [assignment],
        });
      }
      if (path === `/api/tasks/${task.id}/process`) {
        return jsonResponse({
          task,
          assignment,
          assignments: [assignment],
          toolCalls: [],
        });
      }
      if (path === `/api/tasks/${task.id}/delegate` && init?.method === "POST") {
        return jsonResponse({
          ...assignment,
          id: "assignment-retry",
          status: "running" as const,
          worktreeCleanedAt: undefined,
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Blocked" })).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: `Open process for ${task.title}` }));

    const dialog = await screen.findByRole("dialog", { name: task.title });
    expect(within(dialog).getAllByText("Exit 42").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("1 failed test")).toBeVisible();
    expect(within(dialog).getByText("Attempt 1")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Retry Worker" }));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `/api/tasks/${task.id}/delegate` && init?.method === "POST",
      ),
    ).toBe(true);
    expect(within(dialog).getByText("Attempt 1")).toBeVisible();
  });

  it("delegates an unstarted task from its process dialog", async () => {
    window.history.replaceState({}, "", "/surfaces/taskboard");
    const thread = {
      id: "thread-delegate",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
    };
    const task = {
      id: "task-delegate",
      workspaceId: workspace.id,
      title: "Implement the repository feature",
      description: "Build and verify it.",
      status: "todo" as const,
      assigneeId: null,
      threadId: thread.id,
      verificationCommand: "pnpm test",
      createdAt: now,
      updatedAt: now,
    };
    const repository = {
      id: "repository-delegate",
      workspaceId: workspace.id,
      kind: "repository" as const,
      name: "Product repository",
      handle: "product-repo",
      description: "",
      source: "https://github.com/example/product.git",
      storagePath: "workspaces/workspace-nexestra/repositories/product/source",
      status: "ready" as const,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now,
    };
    const assignment = {
      id: "assignment-delegate",
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: "",
      workerAgentId: workerAgent.id,
      repositoryId: repository.id,
      status: "running" as const,
      branch: "nexestra/assignment-delegate",
      worktreePath: "workspaces/workspace-nexestra/worktrees/assignment-delegate",
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [thread],
          tasks: [task],
          knowledge: [repository],
        });
      }
      if (path === `/api/tasks/${task.id}/process`) {
        return jsonResponse({ task, toolCalls: [] });
      }
      if (path === `/api/tasks/${task.id}/delegate` && init?.method === "POST") {
        return jsonResponse(assignment);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: `Open process for ${task.title}` }));
    const dialog = await screen.findByRole("dialog", { name: task.title });
    expect(within(dialog).getByRole("combobox", { name: "Worker" })).toHaveValue(workerAgent.id);
    expect(within(dialog).getByRole("combobox", { name: "Repository" })).toHaveValue(repository.id);
    await user.click(within(dialog).getByRole("button", { name: "Delegate Worker" }));
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `/api/tasks/${task.id}/delegate` && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("shows task details and supports editing and deletion", async () => {
    window.history.replaceState({}, "", "/surfaces/taskboard");
    const task = {
      id: "task-documentation",
      workspaceId: workspace.id,
      title: "Draft documentation",
      description: "Write the first draft.",
      status: "todo" as const,
      assigneeId: null,
      threadId: null,
      createdAt: now,
      updatedAt: now,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, tasks: [task] });
      }
      if (path === `/api/tasks/${task.id}/process`) {
        return jsonResponse({ task, toolCalls: [] });
      }
      if (path === `/api/tasks/${task.id}` && init?.method === "PATCH") {
        return jsonResponse({ ...task, title: "Publish documentation" });
      }
      if (path === `/api/tasks/${task.id}` && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: `Open process for ${task.title}` }));
    let details = await screen.findByRole("dialog", { name: task.title });
    expect(within(details).getByText("Write the first draft.")).toBeVisible();
    await user.click(within(details).getByRole("button", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: `Edit ${task.title}` });
    const titleInput = within(editDialog).getByRole("textbox", { name: "Title" });
    await user.clear(titleInput);
    await user.type(titleInput, "Publish documentation");
    await user.click(within(editDialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === `/api/tasks/${task.id}` && init?.method === "PATCH",
      );
      expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
        title: "Publish documentation",
        description: "Write the first draft.",
      });
    });

    await user.click(screen.getByRole("button", { name: `Open process for ${task.title}` }));
    details = await screen.findByRole("dialog", { name: task.title });
    await user.click(within(details).getByRole("button", { name: "Delete" }));
    const confirmation = screen.getByRole("dialog", { name: `Delete ${task.title}?` });
    await user.click(within(confirmation).getByRole("button", { name: "Delete task" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input) === `/api/tasks/${task.id}` && init?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });
});

describe("Master harness", () => {
  it("creates a custom Master with one access mode", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") return jsonResponse(bootstrapData);
      if (path === "/api/agents" && init?.method === "POST") return jsonResponse({}, 201);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    const dialog = screen.getByRole("dialog", { name: "Create agent" });
    await user.click(within(dialog).getByRole("button", { name: /Master/ }));
    await user.click(within(dialog).getByRole("button", { name: "OpenAI-compatible" }));
    await user.type(within(dialog).getByPlaceholderText("Maya"), "Maya");
    await user.type(within(dialog).getByPlaceholderText("Local gateway"), "Gateway");
    await user.type(
      within(dialog).getByPlaceholderText("https://api.example.com/v1"),
      "https://gateway.example/v1",
    );
    await user.type(within(dialog).getByPlaceholderText("model-name"), "model-a");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Access mode" }), "auto");
    await user.click(within(dialog).getByRole("button", { name: "Create agent" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) => String(input) === "/api/agents" && init?.method === "POST",
        ),
      ).toBe(true);
    });
    const request = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === "/api/agents" && init?.method === "POST",
    );
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({
      kind: "master",
      name: "Maya",
      handle: "maya",
      accessMode: "auto",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
  });

  it("shows pending tool details and sends approval and question responses", async () => {
    const thread = {
      id: "thread-tools",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
    };
    const masterAgent: AgentView = {
      id: "agent-master",
      workspaceId: workspace.id,
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      enabled: true,
      archived: false,
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        hasCredential: false,
      },
      createdAt: now,
      updatedAt: now,
      readiness: "busy",
      readinessLabel: "Responding",
    };
    const transcript: ThreadData = {
      thread,
      messages: [
        {
          id: "message-tools",
          threadId: thread.id,
          sequence: 1,
          author: { kind: "user", id: "local-user", name: "You" },
          content: "@maya run the tests",
          mentions: [{ agentId: masterAgent.id, handle: masterAgent.handle }],
          knowledgeReferences: [],
          artifactIds: [],
          createdAt: now,
        },
      ],
      artifacts: [],
      runs: [
        {
          id: "run-tools",
          threadId: thread.id,
          triggerMessageId: "message-tools",
          agentId: masterAgent.id,
          attempt: 1,
          status: "waiting_input",
          createdAt: now,
          updatedAt: now,
        },
      ],
      toolCalls: [
        {
          id: "tool-tools",
          runId: "run-tools",
          threadId: thread.id,
          agentId: masterAgent.id,
          name: "bash",
          permission: "bash",
          status: "waiting_approval",
          input: '{"command":"pnpm test"}',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "tool-question",
          runId: "run-tools",
          threadId: thread.id,
          agentId: masterAgent.id,
          name: "question",
          permission: "question",
          status: "waiting_input",
          input: '{"questions":[{"question":"Continue?"}]}',
          questions: [
            {
              header: "Decision",
              question: "Continue?",
              options: [{ label: "Proceed", description: "Keep going." }],
              multiple: false,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, agents: [masterAgent], threads: [thread] });
      }
      if (path === historyUrl(thread)) return jsonResponse(historySnapshot(transcript));
      if (path === "/api/tool-calls/tool-tools/approve" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      if (path === "/api/tool-calls/tool-question/respond" && init?.method === "POST") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByText('{"command":"pnpm test"}')).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("radio", { name: /Proceed/ }));
    await user.click(screen.getByRole("button", { name: "Send answer" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/tool-calls/tool-tools/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(fetchMock).toHaveBeenCalledWith("/api/tool-calls/tool-question/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [["Proceed"]] }),
      });
    });
  });
});

describe("Agent deletion", () => {
  it("requires confirmation, supports cancellation, and permanently deletes the agent", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    let deleted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, agents: deleted ? [] : [workerAgent] });
      }
      if (path === `/api/agents/${workerAgent.id}` && init?.method === "DELETE") {
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Delete @planner" }));

    let dialog = screen.getByRole("dialog", { name: "Delete @planner?" });
    expect(dialog).toHaveTextContent("This action cannot be undone.");
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/agents/${workerAgent.id}`,
      expect.objectContaining({ method: "DELETE" }),
    );

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delete @planner?" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/agents/${workerAgent.id}`,
      expect.objectContaining({ method: "DELETE" }),
    );

    await user.click(screen.getByRole("button", { name: "Delete @planner" }));
    dialog = screen.getByRole("dialog", { name: "Delete @planner?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete agent" }));

    await screen.findByText("Deleted @planner.");
    expect(screen.queryByText("@planner")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Create agent" })).toHaveFocus();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/agents/${workerAgent.id}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("keeps archived agents reachable for permanent deletion", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const archivedAgent: AgentView = {
      ...workerAgent,
      id: "agent-archived",
      handle: "archived-planner",
      enabled: false,
      archived: true,
      readiness: "disabled",
      readinessLabel: "Archived",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...bootstrapData, agents: [archivedAgent] })),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Archived agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete @archived-planner" })).toBeInTheDocument();
  });

  it("keeps keyboard focus inside the confirmation while deletion is pending", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    let finishDelete: () => void = () => undefined;
    const deleteGate = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    let deleted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, agents: deleted ? [] : [workerAgent] });
        }
        if (path === `/api/agents/${workerAgent.id}` && init?.method === "DELETE") {
          await deleteGate;
          deleted = true;
          return new Response(null, { status: 204 });
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Delete @planner" }));
    const dialog = screen.getByRole("dialog", { name: "Delete @planner?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete agent" }));

    expect(await within(dialog).findByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(dialog).toHaveAttribute("aria-busy", "true");
    await user.tab();
    expect(dialog).toHaveFocus();

    finishDelete();
    await screen.findByText("Deleted @planner.");
  });

  it("renders a deleted agent's historical message as an agent message", async () => {
    window.history.replaceState({}, "", "/threads/general");
    const thread = {
      id: "thread-general",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 2,
      lastMessageAt: now,
      archived: false,
    };
    const transcript: ThreadData = {
      thread,
      messages: [
        {
          id: "message-trigger",
          threadId: thread.id,
          sequence: 1,
          author: { kind: "user", id: "local-user", name: "You" },
          content: "Please retry @former-planner",
          mentions: [{ agentId: "deleted-agent", handle: "former-planner" }],
          knowledgeReferences: [],
          artifactIds: [],
          createdAt: now,
        },
        {
          id: "message-1",
          threadId: thread.id,
          sequence: 2,
          author: {
            kind: "agent",
            id: "deleted-agent",
            name: "Former Planner",
            handle: "former-planner",
          },
          content: "A reply worth keeping.",
          mentions: [],
          knowledgeReferences: [],
          artifactIds: [],
          triggerMessageId: "message-trigger",
          createdAt: now,
        },
      ],
      artifacts: [],
      runs: [
        {
          id: "run-1",
          threadId: thread.id,
          triggerMessageId: "message-trigger",
          agentId: "deleted-agent",
          attempt: 1,
          status: "failed",
          error: "Previous failure",
          createdAt: now,
          updatedAt: now,
        },
      ],
      toolCalls: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        }
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(transcript));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );

    render(<App />);

    const content = await screen.findByText("A reply worth keeping.");
    const message = content.closest("article");
    expect(message).not.toBeNull();
    expect(within(message as HTMLElement).getByText("AGENT")).toBeInTheDocument();
    expect(within(message as HTMLElement).queryByText("ME")).not.toBeInTheDocument();
    expect(screen.getByText("@former-planner could not reply")).toBeInTheDocument();
    expect(screen.getByText("Agent deleted")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("saves an unknown deleted handle as plain text without invoking an agent", async () => {
    const user = userEvent.setup();
    const thread = {
      id: "thread-general",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastMessageAt: null,
      archived: false,
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const emptyTranscript: ThreadData = {
      thread,
      messages: [],
      artifacts: [],
      runs: [],
      toolCalls: [],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      if (path === historyUrl(thread) && !init?.method) {
        return jsonResponse(historySnapshot(emptyTranscript));
      }
      if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
        return jsonResponse({ message: {}, runs: [] }, 201);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Keep a note for @former-planner");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input) === `/api/threads/${thread.id}/messages` && init?.method === "POST",
      );
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        content: "Keep a note for @former-planner",
        requestId: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        ),
      });
    });
    expect(screen.queryByText("Unknown @former-planner.")).not.toBeInTheDocument();
  });
});

describe("Thread composer", () => {
  it("provides Slack-style composer controls and applies Markdown formatting", async () => {
    const user = userEvent.setup();
    const thread = {
      id: "thread-composer",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastMessageAt: null,
      archived: false,
    };
    const transcript: ThreadData = {
      thread,
      messages: [],
      artifacts: [],
      runs: [],
      toolCalls: [],
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
        }
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(transcript));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    const formatToggle = screen.getByRole("button", { name: "Toggle formatting" });
    expect(formatToggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("toolbar", { name: "Message formatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to message" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Mention an agent" })).toBeVisible();

    await user.click(formatToggle);
    expect(screen.getByRole("toolbar", { name: "Message formatting" })).toBeVisible();
    for (const name of [
      "Bold",
      "Italic",
      "Strikethrough",
      "Link",
      "Numbered list",
      "Bulleted list",
      "Quote",
      "Inline code",
      "Code block",
    ]) {
      expect(screen.getByRole("button", { name })).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "Reference knowledge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record video/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /record audio/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /shortcut/i })).not.toBeInTheDocument();

    await user.type(composer, "hello world");
    act(() => {
      composer.focus();
      (composer as HTMLTextAreaElement).setSelectionRange(6, 11);
    });
    await user.click(screen.getByRole("button", { name: "Bold" }));
    await waitFor(() => expect(composer).toHaveValue("hello **world**"));
    expect(composer).toHaveFocus();
    expect((composer as HTMLTextAreaElement).selectionStart).toBe(8);
    expect((composer as HTMLTextAreaElement).selectionEnd).toBe(13);
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    await waitFor(() => expect(composer).toHaveValue("- hello **world**"));
    await user.click(screen.getByRole("button", { name: "Bulleted list" }));
    await waitFor(() => expect(composer).toHaveValue("hello **world**"));

    act(() => {
      (composer as HTMLTextAreaElement).setSelectionRange(15, 15);
    });
    await user.click(screen.getByRole("button", { name: "Mention an agent" }));
    expect(await screen.findByRole("listbox", { name: "Choose an agent" })).toBeVisible();
    await user.keyboard("{Enter}");
    expect(composer).toHaveValue("hello **world** @planner ");

    const fileInput = screen.getByLabelText("Choose files or images");
    const fileInputClick = vi.spyOn(fileInput, "click");
    const addButton = screen.getByRole("button", { name: "Add to message" });
    expect(addButton).toHaveAttribute("aria-expanded", "false");
    await user.click(addButton);
    expect(fileInputClick).not.toHaveBeenCalled();
    expect(addButton).toHaveAttribute("aria-expanded", "true");
    const addMenu = screen.getByRole("menu", { name: "Add to message" });
    const addItems = within(addMenu).getAllByRole("menuitem");
    expect(addItems).toHaveLength(1);
    expect(addItems[0]).toHaveAccessibleName("File");
    expect(addItems[0]).toHaveFocus();
    await user.click(addButton);
    expect(addButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu", { name: "Add to message" })).not.toBeInTheDocument();

    await user.click(addButton);
    expect(screen.getByRole("menuitem", { name: "File" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Add to message" })).not.toBeInTheDocument();
    expect(addButton).toHaveFocus();

    await user.click(addButton);
    const fileItem = within(screen.getByRole("menu", { name: "Add to message" })).getByRole(
      "menuitem",
      { name: "File" },
    );
    await user.click(fileItem);
    expect(fileInputClick).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "Add to message" })).not.toBeInTheDocument();
  });

  it("restores per-thread drafts across navigation and marks thread rows", async () => {
    const user = userEvent.setup();
    const first = activityThread("thread-draft-first", "general");
    const second = activityThread("thread-draft-second", "notes");
    const transcriptOf = (thread: Thread): ThreadData => threadSnapshot(thread, []);
    window.history.replaceState({}, "", `/threads/${first.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [first, second] });
        }
        if (path === historyUrl(first)) return jsonResponse(transcriptOf(first));
        if (path === historyUrl(second)) return jsonResponse(transcriptOf(second));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    let composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Plan next steps");
    expect(screen.getByRole("button", { name: /#general/ })).toHaveTextContent("Draft");

    await user.click(screen.getByRole("button", { name: /#notes/ }));
    composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Second ideas");
    expect(screen.getByRole("button", { name: /#general/ })).toHaveTextContent("Draft");
    expect(screen.getByRole("button", { name: /#notes/ })).toHaveTextContent("Draft");

    await user.click(screen.getByRole("button", { name: /#general/ }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Plan next steps"),
    );
    await user.click(screen.getByRole("button", { name: /#notes/ }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Second ideas"),
    );
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${first.id}`)).toBe(
      "Plan next steps",
    );
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${second.id}`)).toBe(
      "Second ideas",
    );
  });

  it("keeps drafts separate when two workspaces share a thread id", async () => {
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const shared = activityThread("thread-shared", "general");
    const sharedInProduct: Thread = { ...shared, workspaceId: productWorkspace.id };
    let activeThread = shared;
    window.history.replaceState({}, "", `/threads/${shared.id}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/bootstrap" || path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        activeThread = shared;
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          threads: [shared],
        });
      }
      if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
        activeThread = sharedInProduct;
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          workspace: productWorkspace,
          threads: [sharedInProduct],
        });
      }
      if (path === historyUrl(activeThread)) {
        return jsonResponse(threadSnapshot(activeThread, []));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    let composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Nexestra draft");
    await user.click(screen.getByRole("button", { name: "Switch to Product" }));
    composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue("");
    await user.type(composer, "Product draft");

    await user.click(screen.getByRole("button", { name: "Switch to Nexestra" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Nexestra draft"),
    );
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${shared.id}`)).toBe(
      "Nexestra draft",
    );
    expect(window.localStorage.getItem(`nexestra.draft.${productWorkspace.id}:${shared.id}`)).toBe(
      "Product draft",
    );
  });

  it("keeps a draft in memory and explains when browser storage is denied", async () => {
    const user = userEvent.setup();
    const thread = activityThread("thread-draft-denied", "general");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        }
        if (path === historyUrl(thread)) return jsonResponse(threadSnapshot(thread, []));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Keep me in this tab");
    expect(composer).toHaveValue("Keep me in this tab");
    expect(
      await screen.findByText(
        "Browser storage is unavailable. Draft changes stay in this tab until you close it.",
      ),
    ).toBeVisible();
    vi.restoreAllMocks();
  });
  it("restores a stored draft on hydration without clearing it", async () => {
    const thread = activityThread("thread-draft-hydrated", "general");
    const key = `nexestra.draft.${workspace.id}:${thread.id}`;
    window.localStorage.setItem(key, "Saved across reload");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        }
        if (path === historyUrl(thread)) return jsonResponse(threadSnapshot(thread, []));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue("Saved across reload");
    expect(screen.getByRole("button", { name: /#general/ })).toHaveTextContent("Draft");
    expect(window.localStorage.getItem(key)).toBe("Saved across reload");
  });

  it("keeps the draft and shows an error when sending fails", async () => {
    const user = userEvent.setup();
    const thread = activityThread("thread-draft-failed", "general");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        }
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          return jsonResponse({ error: { message: "Unavailable" } }, 503);
        }
        if (path === historyUrl(thread)) return jsonResponse(threadSnapshot(thread, []));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Keep me after failure");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Unavailable");
    expect(composer).toHaveValue("Keep me after failure");
    expect(screen.getByRole("button", { name: /#general/ })).toHaveTextContent("Draft");
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${thread.id}`)).toBe(
      "Keep me after failure",
    );
  });

  it("retires the sent legacy draft so a reload does not resurrect it", async () => {
    const user = userEvent.setup();
    const thread = activityThread("thread-draft-legacy", "general");
    const legacyKey = `nexestra.draft.${thread.id}`;
    window.localStorage.setItem(legacyKey, "Sent long ago");
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
        return jsonResponse({ message: {}, runs: [] }, 201);
      }
      if (path === historyUrl(thread)) return jsonResponse(threadSnapshot(thread, []));
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<App />);
    let composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue("Sent long ago");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${thread.id}`)).toBe(""),
    );
    first.unmount();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("/api/bootstrap")) {
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        }
        if (String(input) === historyUrl(thread)) {
          return jsonResponse(threadSnapshot(thread, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);
    composer = await screen.findByRole("combobox", { name: "Message" });
    expect(composer).toHaveValue("");
    expect(screen.getByRole("button", { name: /#general/ })).not.toHaveTextContent("Draft");
  });

  it("keeps revisions monotonic when the composer is cleared and retyped during flight", async () => {
    const user = userEvent.setup();
    const thread = activityThread("thread-draft-aba", "general");
    const pending = deferredResponse();
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        }
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          return pending.promise;
        }
        if (path === historyUrl(thread)) return jsonResponse(threadSnapshot(thread, []));
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Old");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.clear(composer);
    await user.type(composer, "Newer");
    expect(composer).toHaveValue("Newer");
    await act(async () => {
      pending.resolve(jsonResponse({ message: {}, runs: [] }, 201));
    });
    await waitFor(() => expect(composer).toHaveValue("Newer"));
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${thread.id}`)).toBe(
      "Newer",
    );
  });

  it("clears only the sent revision when the composer is edited during flight", async () => {
    const user = userEvent.setup();
    const thread = activityThread("thread-draft-revision", "general");
    const pending = deferredResponse();
    let threadReads = 0;
    const posted: unknown[] = [];
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
        posted.push(JSON.parse(String(init?.body)));
        return pending.promise;
      }
      if (path === historyUrl(thread)) {
        threadReads += 1;
        return jsonResponse(threadSnapshot(thread, []));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "First revision");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.type(composer, " Second");
    expect(composer).toHaveValue("First revision Second");

    await act(async () => {
      pending.resolve(jsonResponse({ message: {}, runs: [] }, 201));
    });
    await waitFor(() => expect(threadReads).toBe(2));
    expect(posted).toEqual([
      {
        content: "First revision",
        requestId: expect.stringMatching(
          /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
        ),
      },
    ]);
    expect(composer).toHaveValue("First revision Second");
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${thread.id}`)).toBe(
      "First revision Second",
    );
  });
});

describe("Thread artifacts", () => {
  it("sends selected files as multipart attachments", async () => {
    const user = userEvent.setup();
    const thread = {
      id: "thread-attachments",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      lastMessageAt: null,
      archived: false,
    };
    const transcript: ThreadData = {
      thread,
      messages: [],
      artifacts: [],
      runs: [],
      toolCalls: [],
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      if (path === historyUrl(thread) && !init?.method) {
        return jsonResponse(historySnapshot(transcript));
      }
      if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
        return jsonResponse({ message: {}, runs: [] }, 201);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    const input = await screen.findByLabelText("Choose files or images");
    const file = new File(["diagram"], "diagram.png", { type: "image/png" });
    await user.upload(input, file);
    expect(screen.getByText("diagram.png")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([value, init]) =>
          String(value) === `/api/threads/${thread.id}/messages` && init?.method === "POST",
      );
      expect(request?.[1]?.body).toBeInstanceOf(FormData);
      const body = request?.[1]?.body as FormData;
      expect(body.get("content")).toBe("");
      expect((body.get("files") as File).name).toBe("diagram.png");
    });
  });

  it("lists and filters uploaded files, images, and referenced links", async () => {
    const user = userEvent.setup();
    const thread = {
      id: "thread-artifacts",
      workspaceId: workspace.id,
      name: "general",
      slug: "general",
      createdAt: now,
      updatedAt: now,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
    };
    const message = {
      id: "message-artifacts",
      threadId: thread.id,
      sequence: 1,
      author: { kind: "user" as const, id: "local-user" as const, name: "You" },
      content: "Artifacts",
      mentions: [],
      knowledgeReferences: [],
      artifactIds: ["image", "file", "link"],
      createdAt: now,
    };
    const transcript: ThreadData = {
      thread,
      messages: [message],
      artifacts: [
        {
          id: "image",
          threadId: thread.id,
          messageId: message.id,
          sequence: 2,
          kind: "image",
          source: "upload",
          name: "diagram.png",
          mediaType: "image/png",
          size: 2048,
          createdAt: now,
        },
        {
          id: "file",
          threadId: thread.id,
          messageId: message.id,
          sequence: 3,
          kind: "file",
          source: "upload",
          name: "brief.md",
          mediaType: "text/markdown",
          size: 1024,
          createdAt: now,
        },
        {
          id: "link",
          threadId: thread.id,
          messageId: message.id,
          sequence: 4,
          kind: "link",
          source: "reference",
          name: "https://example.com/spec",
          url: "https://example.com/spec",
          createdAt: now,
        },
      ],
      runs: [],
      toolCalls: [],
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        }
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(transcript));
        if (path === `/api/threads/${thread.id}`) return jsonResponse(transcript);
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Files & links/ }));
    expect(await screen.findByAltText("diagram.png")).toBeInTheDocument();
    expect(screen.getByText("brief.md")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/spec")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Links" }));
    expect(screen.queryByText("brief.md")).not.toBeInTheDocument();
    expect(screen.getByText("https://example.com/spec")).toBeInTheDocument();
  });
});

describe("Thread archive lifecycle", () => {
  it("lists archived threads separately and renders archived detail read-only", async () => {
    const user = userEvent.setup();
    const active = activityThread("thread-active", "Active Thread");
    const archived = {
      ...activityThread("thread-archived", "Old Thread"),
      archived: true,
      messageCount: 3,
    };
    window.history.replaceState({}, "", "/threads/thread-active");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [active, archived] });
        }
        if (path === historyUrl(active)) {
          return jsonResponse(threadSnapshot(active, []));
        }
        if (path === historyUrl(archived)) {
          return jsonResponse(threadSnapshot(archived, []));
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await screen.findByRole("heading", { name: "Active Thread" });
    expect(screen.getByText("Archived", { selector: ".section-label span" })).toBeInTheDocument();
    const archivedRow = await screen.findByRole("button", { name: /Old Thread/ });
    await user.click(archivedRow);

    expect(await screen.findByRole("heading", { name: "Old Thread" })).toBeInTheDocument();
    expect(screen.getByText("ARCHIVED THREAD")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByText(/This thread is archived/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });

  it("does not auto-select an archived thread as the ordinary last thread", async () => {
    window.localStorage.setItem("nexestra.lastThread.workspace-nexestra", "thread-archived");
    const archived = {
      ...activityThread("thread-archived", "Old Thread"),
      archived: true,
    };
    window.history.replaceState({}, "", "/threads");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [archived] });
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    expect(await screen.findByRole("heading", { name: "No active threads" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create thread" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Archived", { selector: ".section-label span" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });
  it("ignores a delayed archive result after switching workspaces", async () => {
    const user = userEvent.setup();
    const productWorkspace = { ...workspace, id: "workspace-product", name: "Product" };
    const local = activityThread("thread-archive-local", "general");
    const product = {
      ...activityThread("thread-archive-product", "notes"),
      workspaceId: productWorkspace.id,
    };
    const pendingArchive = deferredResponse();
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/threads/thread-archive-local");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          workspace: productWorkspace,
          threads: [product],
        });
      }
      if (path === "/api/bootstrap" || path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          threads: [local],
        });
      }
      if (path === `/api/threads/${local.id}/archive`) return pendingArchive.promise;
      if (path === historyUrl(local)) return jsonResponse(threadSnapshot(local, []));
      if (path === historyUrl(product)) {
        return jsonResponse(threadSnapshot(product, []));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);

    await screen.findByRole("heading", { name: "general" });
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/threads/${local.id}/archive`,
        expect.objectContaining({ method: "POST" }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Switch to Product" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    await screen.findByRole("heading", { name: "notes" });

    await act(async () => {
      pendingArchive.resolve(jsonResponse({ ...local, archived: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText("Thread archived.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "notes" })).toBeInTheDocument();
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(productWorkspace.id);
    expect(window.location.pathname).toBe("/threads/thread-archive-product");
  });
  it("opens the empty thread state from a surface when all threads are archived", async () => {
    const user = userEvent.setup();
    const archived = {
      ...activityThread("thread-only-archived", "Old Thread"),
      archived: true,
    };
    window.history.replaceState({}, "", "/surfaces/knowledge");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [archived] });
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Threads" }));
    expect(await screen.findByRole("heading", { name: "No active threads" })).toBeInTheDocument();
    expect(screen.getByText("Archived", { selector: ".section-label span" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create thread" }).length).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/threads");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Agent editing", () => {
  it("submits Worker profile changes as a PATCH", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const updated: AgentView = {
      ...workerAgent,
      name: "New Planner",
      description: "Plans more work",
      instructions: "Be concise.",
    };
    let receivedBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, agents: [updated] });
      if (path === `/api/agents/${workerAgent.id}` && init?.method === "PATCH") {
        receivedBody = JSON.parse(String(init.body));
        return jsonResponse(updated);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit @planner" });
    const nameInput = within(dialog).getByPlaceholderText("Codex Builder");
    await user.clear(nameInput);
    await user.type(nameInput, "New Planner");
    const description = within(dialog).getByPlaceholderText("What does this agent handle?");
    await user.clear(description);
    await user.type(description, "Plans more work");
    const instructions = within(dialog).getByPlaceholderText(
      "Role, response style, and agent boundaries…",
    );
    await user.clear(instructions);
    await user.type(instructions, "Be concise.");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/agents/${workerAgent.id}`,
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    expect(receivedBody).toEqual({
      name: "New Planner",
      handle: "planner",
      description: "Plans more work",
      instructions: "Be concise.",
      harness: "codex",
      model: null,
      reasoningEffort: null,
    });
    await screen.findByText("Agent updated.");
  });
  it("rotates an existing custom Master credential without removing it first", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const masterAgent: AgentView = {
      id: "agent-master",
      workspaceId: workspace.id,
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      enabled: true,
      archived: false,
      accessMode: "auto",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        hasCredential: true,
      },
      createdAt: now,
      updatedAt: now,
      readiness: "ready",
      readinessLabel: "Ready",
    };
    let receivedBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, agents: [masterAgent] });
      }
      if (path === `/api/agents/${masterAgent.id}` && init?.method === "PATCH") {
        receivedBody = JSON.parse(String(init.body));
        return jsonResponse(masterAgent);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit @maya" });
    expect(dialog).toHaveTextContent("A key is already stored. Leave blank to keep it.");
    await user.type(within(dialog).getByPlaceholderText("••••••••••"), "sk-rotated");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(receivedBody).toBeDefined();
    });
    const body = receivedBody as { provider: Record<string, unknown> };
    expect(body.provider).toMatchObject({ type: "custom", apiKey: "sk-rotated" });
    expect(body.provider).not.toHaveProperty("removeCredential");
  });
  it("removes a stored custom Master credential explicitly", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const masterAgent: AgentView = {
      id: "agent-master",
      workspaceId: workspace.id,
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      enabled: true,
      archived: false,
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        hasCredential: true,
      },
      createdAt: now,
      updatedAt: now,
      readiness: "ready",
      readinessLabel: "Ready",
    };
    let receivedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, agents: [masterAgent] });
        }
        if (path === `/api/agents/${masterAgent.id}` && init?.method === "PATCH") {
          receivedBody = JSON.parse(String(init.body));
          return jsonResponse(masterAgent);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit @maya" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Remove the stored key" }));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(receivedBody).toBeDefined();
    });
    const body = receivedBody as { provider: Record<string, unknown> };
    expect(body.provider).toMatchObject({ type: "custom", removeCredential: true });
    expect(body.provider).not.toHaveProperty("apiKey");
  });
  it("keeps the removal checkbox visible and retains the stored key when unchecked before save", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const masterAgent: AgentView = {
      id: "agent-master",
      workspaceId: workspace.id,
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      enabled: true,
      archived: false,
      accessMode: "auto",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        hasCredential: true,
      },
      createdAt: now,
      updatedAt: now,
      readiness: "ready",
      readinessLabel: "Ready",
    };
    let receivedBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, agents: [masterAgent] });
      }
      if (path === `/api/agents/${masterAgent.id}` && init?.method === "PATCH") {
        receivedBody = JSON.parse(String(init.body));
        return jsonResponse(masterAgent);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit @maya" });
    const removal = within(dialog).getByRole("checkbox", { name: "Remove the stored key" });
    const keyInput = within(dialog).getByPlaceholderText("••••••••••");
    await user.click(removal);
    expect(removal).toBeChecked();
    expect(removal).toBeInTheDocument();
    expect(keyInput).toBeDisabled();
    await user.click(removal);
    expect(removal).not.toBeChecked();
    expect(keyInput).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(receivedBody).toBeDefined();
    });
    const body = receivedBody as { provider: Record<string, unknown> };
    expect(body.provider).toMatchObject({ type: "custom" });
    expect(body.provider).not.toHaveProperty("removeCredential");
    expect(body.provider).not.toHaveProperty("apiKey");
  });
  it("switches from removal back to rotation without sending removeCredential", async () => {
    window.history.replaceState({}, "", "/surfaces/agents");
    const masterAgent: AgentView = {
      id: "agent-master",
      workspaceId: workspace.id,
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      enabled: true,
      archived: false,
      accessMode: "auto",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        hasCredential: true,
      },
      createdAt: now,
      updatedAt: now,
      readiness: "ready",
      readinessLabel: "Ready",
    };
    let receivedBody: unknown;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap") {
        return jsonResponse({ ...bootstrapData, agents: [masterAgent] });
      }
      if (path === `/api/agents/${masterAgent.id}` && init?.method === "PATCH") {
        receivedBody = JSON.parse(String(init.body));
        return jsonResponse(masterAgent);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit @maya" });
    const removal = within(dialog).getByRole("checkbox", { name: "Remove the stored key" });
    const keyInput = within(dialog).getByPlaceholderText("••••••••••");
    await user.click(removal);
    expect(keyInput).toBeDisabled();
    await user.click(removal);
    expect(keyInput).toBeEnabled();
    await user.type(keyInput, "sk-rotated");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      expect(receivedBody).toBeDefined();
    });
    const body = receivedBody as { provider: Record<string, unknown> };
    expect(body.provider).toMatchObject({ type: "custom", apiKey: "sk-rotated" });
    expect(body.provider).not.toHaveProperty("removeCredential");
  });
});

describe("Repository source branch selection", () => {
  const repoMainCommit = "a".repeat(40);
  const repoDevCommit = "b".repeat(40);
  const branchRepository = {
    id: "repository-branch",
    workspaceId: workspace.id,
    kind: "repository" as const,
    name: "Branch repository",
    handle: "branch-repo",
    description: "",
    source: "https://github.com/example/branch.git",
    storagePath: "workspaces/workspace-nexestra/repositories/branch/source",
    status: "ready" as const,
    defaultBranch: "main",
    sourceCommit: repoMainCommit,
    sourceRef: "main",
    refreshedAt: now,
    sourceVersion: 3,
    createdAt: now,
    updatedAt: now,
  };
  const branchListResponse = (sourceVersion: number) => ({
    branches: [
      { name: "main", commit: repoMainCommit },
      { name: "develop", commit: repoDevCommit },
    ],
    truncated: false,
    sourceVersion,
    selectedBranch: null,
    defaultBranch: "main",
  });

  it("applies a listed branch from knowledge details and updates without a bootstrap reload", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let bootstraps = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({ ...bootstrapData, knowledge: [branchRepository] });
      }
      if (path === "/api/knowledge/repository-branch/branches") {
        expect(bootstraps).toBe(1);
        return jsonResponse(branchListResponse(3));
      }
      if (path === "/api/knowledge/repository-branch/source-branch") {
        return jsonResponse({
          ...branchRepository,
          selectedBranch: "develop",
          sourceVersion: 4,
          updatedAt: "2026-09-02T13:00:00.000Z",
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${branchRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: branchRepository.name });
    expect(within(details).getByText("main")).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/branches"))).toBe(false);

    await user.click(within(details).getByRole("button", { name: "Change branch" }));
    await user.click(await within(details).findByRole("button", { name: /develop/ }));
    await user.click(within(details).getByRole("button", { name: "Apply branch" }));
    expect(await screen.findByText("Source branch set to develop.")).toBeVisible();
    const updated = screen.getByRole("dialog", { name: branchRepository.name });
    expect(within(updated).getByText("develop")).toBeVisible();
    expect(within(updated).getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(bootstraps).toBe(1);
    const postCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/knowledge/repository-branch/source-branch",
    ) as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ branch: "develop", expectedSourceVersion: 3 }),
    });
    const changeBranch = within(updated).getByRole("button", { name: "Change branch" });
    expect(changeBranch).toBeEnabled();
    await waitFor(() => expect(changeBranch).toHaveFocus());
    await user.click(changeBranch);
    expect(changeBranch).toHaveAttribute("aria-expanded", "true");
    await user.click(await within(updated).findByRole("button", { name: /develop/ }));
    expect(within(updated).getByRole("button", { name: "Apply branch" })).toBeEnabled();
  });

  it("shows the selected branch over the clone default as the effective branch", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const selected = {
      ...branchRepository,
      selectedBranch: "release",
      sourceVersion: 2,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [selected] });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(screen.getByRole("button", { name: `View details for ${selected.name}` }));
    const details = screen.getByRole("dialog", { name: selected.name });
    expect(within(details).getByText("release")).toBeVisible();
    expect(within(details).getByText("Clone default: main")).toBeVisible();
    await user.click(within(details).getByRole("button", { name: "Done" }));
  });

  it("keeps the previous branch and the picker open when the server reports a refresh error", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [branchRepository] });
      }
      if (path === "/api/knowledge/repository-branch/branches") {
        return jsonResponse(branchListResponse(3));
      }
      if (path === "/api/knowledge/repository-branch/source-branch") {
        return jsonResponse({
          ...branchRepository,
          refreshError: "Remote is offline.",
          updatedAt: "2026-09-02T13:00:00.000Z",
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${branchRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: branchRepository.name });
    await user.click(within(details).getByRole("button", { name: "Change branch" }));
    await user.click(await within(details).findByRole("button", { name: /develop/ }));
    await user.click(within(details).getByRole("button", { name: "Apply branch" }));
    expect(await within(details).findByText("Remote is offline.")).toBeVisible();
    expect(screen.queryByText("Source branch set to")).not.toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(details).getByLabelText("Branch name")).toHaveValue("develop");
    expect(within(details).getByRole("button", { name: "Apply branch" })).toBeEnabled();
    const effectiveRow = within(details).getByText("Effective source branch").closest("div");
    if (!effectiveRow) throw new Error("expected effective branch row");
    expect(within(effectiveRow).getByText("main")).toBeVisible();
  });

  it("requires an explicit reload and re-apply after a 409 source version conflict", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let applications = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [branchRepository] });
      }
      if (path === "/api/knowledge/repository-branch/branches") {
        return jsonResponse({
          ...branchListResponse(applications === 0 ? 3 : 9),
          selectedBranch: applications === 0 ? null : "feature/release",
        });
      }
      if (path === "/api/knowledge/repository-branch/source-branch") {
        applications += 1;
        if (applications === 1) {
          return jsonResponse(
            { error: { code: "SOURCE_VERSION_CONFLICT", message: "Source version changed." } },
            409,
          );
        }
        return jsonResponse({
          ...branchRepository,
          selectedBranch: "develop",
          sourceVersion: 10,
          updatedAt: "2026-09-02T13:00:00.000Z",
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${branchRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: branchRepository.name });
    await user.click(within(details).getByRole("button", { name: "Change branch" }));
    await user.click(await within(details).findByRole("button", { name: /develop/ }));
    await user.click(within(details).getByRole("button", { name: "Apply branch" }));
    expect(await within(details).findByText("Source version changed")).toBeVisible();
    expect(within(details).getByRole("button", { name: "Apply branch" })).toBeDisabled();

    await user.click(within(details).getByRole("button", { name: "Reload branches" }));
    expect(
      await within(details).findByText("Current source branch: feature/release"),
    ).toBeVisible();
    expect(await within(details).findByRole("button", { name: "Apply branch" })).toBeEnabled();
    await user.click(within(details).getByRole("button", { name: "Apply branch" }));
    expect(await screen.findByText("Source branch set to develop.")).toBeVisible();
    const postCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/knowledge/repository-branch/source-branch",
    ) as unknown as Array<[RequestInfo | URL, RequestInit | undefined]>;
    expect(postCalls).toHaveLength(2);
    expect(postCalls.map(([, init]) => String(init?.body))).toEqual([
      JSON.stringify({ branch: "develop", expectedSourceVersion: 3 }),
      JSON.stringify({ branch: "develop", expectedSourceVersion: 9 }),
    ]);
  });

  it("disables refresh, edit, and delete while a branch change is pending", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const pendingApply = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [branchRepository] });
      }
      if (path === "/api/knowledge/repository-branch/branches") {
        return jsonResponse(branchListResponse(3));
      }
      if (path === "/api/knowledge/repository-branch/source-branch") {
        return pendingApply.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${branchRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: branchRepository.name });
    await user.click(within(details).getByRole("button", { name: "Change branch" }));
    await user.click(await within(details).findByRole("button", { name: /develop/ }));
    await user.click(within(details).getByRole("button", { name: "Apply branch" }));

    expect(within(details).getByRole("button", { name: "Refresh source" })).toBeDisabled();
    expect(within(details).getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(within(details).getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(within(details).getByRole("button", { name: "Change branch" })).toBeDisabled();

    await act(async () => {
      pendingApply.resolve(
        jsonResponse({
          ...branchRepository,
          selectedBranch: "develop",
          sourceVersion: 4,
          updatedAt: "2026-09-02T13:00:00.000Z",
        }),
      );
    });
    expect(await screen.findByText("Source branch set to develop.")).toBeVisible();
    expect(
      within(screen.getByRole("dialog", { name: branchRepository.name })).getByRole("button", {
        name: "Refresh source",
      }),
    ).toBeEnabled();
  });

  it("Escape closes only the branch picker while the detail dialog stays open", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [branchRepository] });
      }
      if (path === "/api/knowledge/repository-branch/branches") {
        return jsonResponse(branchListResponse(3));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${branchRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: branchRepository.name });
    await user.click(within(details).getByRole("button", { name: "Change branch" }));
    expect(await within(details).findByRole("button", { name: /develop/ })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Change source branch")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: branchRepository.name })).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog", { name: branchRepository.name })).getByRole("button", {
        name: "Change branch",
      }),
    ).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: branchRepository.name })).not.toBeInTheDocument();
  });

  it("keeps an open branch picker inert while a refresh is running", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const pendingRefresh = deferredResponse();
    let refreshClicked = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [branchRepository] });
      }
      if (path === "/api/knowledge/repository-branch/branches") {
        return jsonResponse(branchListResponse(refreshClicked ? 5 : 3));
      }
      if (path === "/api/knowledge/repositories/repository-branch/refresh") {
        refreshClicked = true;
        return pendingRefresh.promise;
      }
      if (path === "/api/knowledge/repository-branch/source-branch") {
        return jsonResponse({ ...branchRepository, selectedBranch: "develop", sourceVersion: 4 });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${branchRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: branchRepository.name });
    await user.click(within(details).getByRole("button", { name: "Change branch" }));
    await user.click(await within(details).findByRole("button", { name: /develop/ }));
    expect(within(details).getByRole("button", { name: "Apply branch" })).toBeEnabled();

    await user.click(within(details).getByRole("button", { name: "Refresh source" }));
    await waitFor(() =>
      expect(within(details).getByRole("button", { name: "Change branch" })).toBeDisabled(),
    );
    expect(within(details).getByRole("button", { name: "Apply branch" })).toBeDisabled();
    expect(within(details).getByLabelText("Branch name")).toBeDisabled();
    expect(within(details).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/knowledge/repository-branch/source-branch",
      ),
    ).toHaveLength(0);

    await act(async () => {
      pendingRefresh.resolve(
        jsonResponse({
          ...branchRepository,
          sourceCommit: repoDevCommit,
          refreshedAt: "2026-09-02T13:00:00.000Z",
          sourceVersion: 5,
          updatedAt: "2026-09-02T13:00:00.000Z",
        }),
      );
    });
    const refreshedDialog = screen.getByRole("dialog", { name: branchRepository.name });
    expect(within(refreshedDialog).getByRole("button", { name: "Apply branch" })).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/knowledge/repository-branch/source-branch",
      ),
    ).toHaveLength(0);
  });
});

describe("Return to workspace revalidation", () => {
  it("revalidates the visible thread on window focus without idle polling or full-thread reads", async () => {
    const thread = activityThread("thread-idle", "general");
    const transcript: ThreadData = {
      thread,
      messages: [],
      artifacts: [],
      runs: [],
      toolCalls: [],
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const intervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(() => 1 as unknown as ReturnType<typeof window.setInterval>);
    let bootstrapReads = 0;
    let historyReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
      }
      if (path === historyUrl(thread)) {
        historyReads += 1;
        return jsonResponse(historySnapshot(transcript));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    expect(bootstrapReads).toBe(1);
    expect(historyReads).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(bootstrapReads).toBe(2));
    await waitFor(() => expect(historyReads).toBe(2));
    expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/threads/${thread.id}`)).toBe(
      false,
    );
  });

  it("coalesces a focus/visible/online burst into one in-flight request plus one follow-up", async () => {
    const thread = activityThread("thread-burst", "general");
    const updated = { ...thread, name: "Updated general" };
    const transcript: ThreadData = {
      thread,
      messages: [],
      artifacts: [],
      runs: [],
      toolCalls: [],
    };
    const pendingSecond = deferredResponse();
    let bootstrapReads = 0;
    let historyReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        if (bootstrapReads === 1) {
          return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
        }
        if (bootstrapReads === 2) return pendingSecond.promise;
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [updated] });
      }
      if (path === historyUrl(thread)) {
        historyReads += 1;
        const current = historyReads >= 3 ? { ...transcript, thread: updated } : transcript;
        return jsonResponse(historySnapshot(current));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(bootstrapReads).toBe(2));
    expect(historyReads).toBe(1);
    expect(screen.getByRole("button", { name: "Refresh workspace" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(bootstrapReads).toBe(2);
    expect(historyReads).toBe(1);

    await act(async () => {
      pendingSecond.resolve(
        jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [updated] }),
      );
    });
    await waitFor(() => expect(bootstrapReads).toBe(3));
    await waitFor(() => expect(historyReads).toBe(3));
    expect(await screen.findByRole("heading", { name: "# Updated general" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh workspace" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });

  it("refreshes manually, keeps data usable after a failure, and retries", async () => {
    const updatedAgent = { ...workerAgent, name: "Updated planner" };
    let bootstrapReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        if (bootstrapReads === 1) {
          return jsonResponse({ ...bootstrapData, agents: [workerAgent] });
        }
        if (bootstrapReads === 2) {
          return jsonResponse({ error: { message: "Server unavailable" } }, 503);
        }
        return jsonResponse({ ...bootstrapData, agents: [updatedAgent] });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/agents");
    render(<App />);
    await screen.findByRole("heading", { name: "Agent management" });

    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    expect(await screen.findByText("Could not refresh the workspace.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Agent management" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    expect(await screen.findByText("Updated planner")).toBeVisible();
    expect(screen.queryByText("Could not refresh the workspace.")).not.toBeInTheDocument();
  });

  it("refreshes metadata only on a surface and never fetches unrelated history", async () => {
    const thread = activityThread("thread-surface", "general");
    let bootstrapReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    render(<App />);
    await screen.findByRole("heading", { name: "Knowledge" });
    expect(bootstrapReads).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(bootstrapReads).toBe(2));
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/threads/"))).toBe(
      false,
    );
  });

  it("does not load the captured page after the user navigates during a slow revalidation", async () => {
    const firstThread = activityThread("thread-late-first", "general");
    const secondThread = activityThread("thread-late-second", "notes");
    const firstSnapshot = threadSnapshot(firstThread, []);
    const secondSnapshot = threadSnapshot(secondThread, []);
    const pendingBootstrap = deferredResponse();
    let bootstrapReads = 0;
    let firstHistoryReads = 0;
    let secondHistoryReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        if (bootstrapReads === 1) {
          return jsonResponse({ ...bootstrapData, threads: [firstThread, secondThread] });
        }
        return pendingBootstrap.promise;
      }
      if (path === historyUrl(firstThread)) {
        firstHistoryReads += 1;
        return jsonResponse(firstSnapshot);
      }
      if (path === historyUrl(secondThread)) {
        secondHistoryReads += 1;
        return jsonResponse(secondSnapshot);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${firstThread.id}`);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(bootstrapReads).toBe(2));
    await userEvent.click(screen.getByRole("button", { name: /#notes/ }));
    await screen.findByRole("combobox", { name: "Message" });
    const secondReadsAtResolve = secondHistoryReads;

    await act(async () => {
      pendingBootstrap.resolve(
        jsonResponse({ ...bootstrapData, threads: [firstThread, secondThread] }),
      );
    });
    expect(firstHistoryReads).toBe(1);
    expect(secondHistoryReads).toBe(secondReadsAtResolve);
    expect(window.location.pathname).toBe(`/threads/${secondThread.id}`);
  });

  it("keeps the draft, attachments, and selected history page across a focus refresh", async () => {
    const thread = activityThread("thread-preserved", "general");
    const message = {
      id: "message-old",
      threadId: thread.id,
      sequence: 1,
      author: { kind: "user" as const, id: "local-user" as const, name: "You" },
      content: "Older message",
      mentions: [],
      knowledgeReferences: [],
      artifactIds: [],
      createdAt: now,
    };
    const page: ThreadHistoryPage = {
      thread,
      messages: [message],
      artifacts: [],
      runs: [],
      activeRuns: [],
      toolCalls: [],
      page: {
        totalMessages: 100,
        totalArtifacts: 0,
        firstMessageIndex: 1,
        lastMessageIndex: 50,
        beforeCursor: "cursor-before",
        afterCursor: null,
      },
    };
    const beforeQuery = `?workspaceId=${encodeURIComponent(workspace.id)}&limit=50&before=cursor-before`;
    const beforeUrl = `/api/threads/${thread.id}/history${beforeQuery}`;
    let latestReads = 0;
    let beforeReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      if (path === beforeUrl) {
        beforeReads += 1;
        return jsonResponse(page);
      }
      if (path === historyUrl(thread)) {
        latestReads += 1;
        return jsonResponse(page);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.click(screen.getByRole("button", { name: /Older messages/ }));
    await screen.findByText("Older message");
    await user.type(composer, "Draft text");
    const fileInput = screen.getByLabelText("Choose files or images");
    await user.upload(fileInput, new File(["# Notes"], "notes.md", { type: "text/markdown" }));
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(beforeReads).toBe(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(beforeReads).toBe(2));
    expect(composer).toHaveValue("Draft text");
    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText("Older message")).toBeInTheDocument();
    expect(latestReads).toBe(1);
  });

  it("lets the Files & links tab reload its inventory after a focus refresh", async () => {
    const thread = activityThread("thread-artifacts-refresh", "general");
    const message = {
      id: "message-artifacts-refresh",
      threadId: thread.id,
      sequence: 1,
      author: { kind: "user" as const, id: "local-user" as const, name: "You" },
      content: "Artifacts",
      mentions: [],
      knowledgeReferences: [],
      artifactIds: [],
      createdAt: now,
    };
    const artifact = {
      id: "artifact-report",
      threadId: thread.id,
      messageId: message.id,
      sequence: 1,
      kind: "file" as const,
      source: "upload" as const,
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 100,
      createdAt: now,
    };
    const emptySnapshot: ThreadHistoryPage = {
      thread,
      messages: [message],
      artifacts: [],
      runs: [],
      activeRuns: [],
      toolCalls: [],
      page: {
        totalMessages: 1,
        totalArtifacts: 0,
        firstMessageIndex: 1,
        lastMessageIndex: 1,
        beforeCursor: null,
        afterCursor: null,
      },
    };
    const fullSnapshot: ThreadHistoryPage = {
      ...emptySnapshot,
      artifacts: [artifact],
      page: { ...emptySnapshot.page, totalArtifacts: 1 },
    };
    let withArtifacts = false;
    let historyReads = 0;
    let fullReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      if (path === historyUrl(thread)) {
        historyReads += 1;
        if (historyReads === 1 && !withArtifacts) return jsonResponse(emptySnapshot);
        return jsonResponse(fullSnapshot);
      }
      if (path === `/api/threads/${thread.id}`) {
        fullReads += 1;
        return jsonResponse({
          thread,
          messages: [message],
          artifacts: withArtifacts ? [artifact] : [],
          runs: [],
          toolCalls: [],
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    await user.click(screen.getByRole("button", { name: /Files & links/ }));
    await screen.findByText("No files or links yet");
    expect(fullReads).toBe(1);

    withArtifacts = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(fullReads).toBe(2));
    expect(await screen.findByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Files & links/ })).toHaveTextContent("1");
  });
});

describe("Revalidation failure handling", () => {
  it("reports a retryable failure when the visible history read fails", async () => {
    const thread = activityThread("thread-history-failure", "general");
    const transcript: ThreadData = {
      thread,
      messages: [],
      artifacts: [],
      runs: [],
      toolCalls: [],
    };
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    let historyReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      }
      if (path === historyUrl(thread)) {
        historyReads += 1;
        if (historyReads === 2) {
          return jsonResponse({ error: { message: "History unavailable" } }, 503);
        }
        return jsonResponse(historySnapshot(transcript));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });

    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    expect(await screen.findByText("Could not refresh the workspace.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Message" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await waitFor(() => expect(historyReads).toBe(3));
    expect(screen.queryByText("Could not refresh the workspace.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh workspace" })).toHaveAttribute(
      "aria-busy",
      "false",
    );
  });

  it("times out a hung revalidation read and permits a retry", async () => {
    vi.useFakeTimers();
    const updatedAgent = { ...workerAgent, name: "Updated planner" };
    let bootstrapReads = 0;
    let aborted: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        if (bootstrapReads === 1) {
          return jsonResponse({ ...bootstrapData, agents: [workerAgent] });
        }
        if (bootstrapReads >= 3) {
          return jsonResponse({ ...bootstrapData, agents: [updatedAgent] });
        }
        aborted = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/agents");
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("heading", { name: "Agent management" })).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "Refresh workspace" }).click();
    });
    expect(bootstrapReads).toBe(2);
    expect(aborted?.aborted).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(aborted?.aborted).toBe(true);
    expect(screen.getByText("Could not refresh the workspace.")).toBeInTheDocument();

    await act(async () => {
      screen.getByRole("button", { name: "Refresh workspace" }).click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Updated planner")).toBeInTheDocument();
    expect(screen.queryByText("Could not refresh the workspace.")).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

describe("Run history navigation", () => {
  function listing(thread: Thread, run: AgentRun, agentName = workerAgent.name): RunHistoryPage {
    return {
      workspaceId: thread.workspaceId,
      items: [
        {
          run,
          agentName,
          agentHandle: workerAgent.handle,
          threadName: thread.name,
          threadArchived: thread.archived,
        },
      ],
      page: { nextCursor: null },
      coverage: { complete: true, unavailableThreads: 0 },
    };
  }

  function runMessagePage(thread: Thread, run: AgentRun): ThreadHistoryPage {
    const page = threadSnapshot(thread, [run]);
    page.messages = [
      {
        id: run.triggerMessageId,
        threadId: thread.id,
        sequence: 1,
        author: { kind: "user", id: "local-user", name: "You" },
        content: "Inspect this failed run",
        mentions: [],
        knowledgeReferences: [],
        artifactIds: [],
        createdAt: now,
      },
    ];
    page.page = {
      ...page.page,
      totalMessages: thread.messageCount,
      firstMessageIndex: 1,
      lastMessageIndex: 1,
      targetMessageId: run.triggerMessageId,
      targetFound: true,
    };
    return page;
  }

  it("opens an archived run's trigger, returns through Back, and retains the original draft and files", async () => {
    const current = activityThread("run-history-current", "Current conversation");
    const archived = {
      ...activityThread("run-history-archive", "Archived worker"),
      archived: true,
      messageCount: 75,
    };
    const failed = activityRun(archived, "failed");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [current, archived],
        });
      if (path.startsWith("/api/runs?")) return jsonResponse(listing(archived, failed));
      if (path === historyUrl(current)) return jsonResponse(threadSnapshot(current, []));
      if (path === historyUrl(archived, failed.triggerMessageId))
        return jsonResponse(runMessagePage(archived, failed));
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${current.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "Keep this run review draft",
    );
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["context"], "run-context.txt"),
    );
    await user.click(screen.getByRole("button", { name: "Surfaces" }));
    await user.click(screen.getByRole("button", { name: "Run history" }));
    await screen.findByRole("heading", { name: "Run history" });
    expect(screen.queryByRole("button", { name: "Create new" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Open run/ }));
    const selected = await screen.findByRole("region", { name: "Selected message" });
    expect(selected).toHaveTextContent("Inspect this failed run");
    await waitFor(() => expect(selected).toHaveFocus());
    expect(window.location.pathname).toBe(`/threads/${archived.id}`);
    expect(window.location.search).toBe(`?message=${failed.triggerMessageId}`);
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Message" })).not.toBeInTheDocument();
    await act(async () => {
      window.history.back();
    });
    await screen.findByRole("heading", { name: "Run history" });
    expect(window.location.pathname).toBe("/surfaces/runs");
    await user.click(screen.getByRole("button", { name: "Threads" }));
    expect(await screen.findByRole("combobox", { name: "Message" })).toHaveValue(
      "Keep this run review draft",
    );
    expect(screen.getByText("run-context.txt")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((path) => path.includes("/history")),
    ).toEqual([
      historyUrl(current),
      historyUrl(archived, failed.triggerMessageId),
      historyUrl(current),
    ]);
  });

  it("refreshes the current run list from global Refresh while retaining its status filter", async () => {
    const thread = activityThread("run-history-refresh", "History refresh");
    const run = activityRun(thread, "failed");
    let bootstrapReads = 0;
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstrapReads += 1;
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
      }
      if (path.startsWith("/api/runs?")) {
        requests.push(path);
        return jsonResponse(
          listing(thread, run, bootstrapReads > 1 ? "Updated runner" : "Original runner"),
        );
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/runs");
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /Open run/ });
    await user.selectOptions(screen.getByRole("combobox", { name: "Run status" }), "failed");
    await waitFor(() => expect(requests).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await screen.findByRole("button", { name: /Open run.*Updated runner/ });
    expect(requests).toHaveLength(3);
    expect(new URL(requests[2] ?? "", "http://localhost").searchParams.get("status")).toBe(
      "failed",
    );
    expect(screen.getByRole("combobox", { name: "Run status" })).toHaveValue("failed");
    expect(bootstrapReads).toBe(2);
  });

  it("recovers the previous run history after a failed workspace switch and allows another attempt", async () => {
    const secondWorkspace = { ...workspace, id: "workspace-recovery-second", name: "Second" };
    const first = activityThread("run-switch-recovery-first", "First history");
    const second = {
      ...activityThread("run-switch-recovery-second", "Second history"),
      workspaceId: secondWorkspace.id,
    };
    const secondAgent = {
      ...workerAgent,
      id: "second-recovery-runner",
      workspaceId: secondWorkspace.id,
      name: "Second runner",
    };
    let secondAttempts = 0;
    let firstBootstrapReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        if (path.includes(secondWorkspace.id)) {
          secondAttempts += 1;
          if (secondAttempts === 1)
            return jsonResponse({ error: { message: "Second workspace unavailable" } }, 503);
          return jsonResponse({
            ...bootstrapData,
            workspaces: [workspace, secondWorkspace],
            workspace: secondWorkspace,
            agents: [secondAgent],
            threads: [second],
          });
        }
        firstBootstrapReads += 1;
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, secondWorkspace],
          agents: [workerAgent],
          threads: [first],
        });
      }
      if (path.startsWith("/api/runs?")) {
        return jsonResponse(
          path.includes(secondWorkspace.id)
            ? listing(
                second,
                { ...activityRun(second, "completed"), agentId: secondAgent.id },
                secondAgent.name,
              )
            : listing(first, activityRun(first, "failed"), "Original runner"),
        );
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/runs");
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("button", { name: /Open run.*Original runner/ });
    await user.click(screen.getByRole("button", { name: "Switch to Second" }));
    await screen.findByText("Second workspace unavailable");
    await screen.findByRole("button", { name: /Open run.*Original runner/ });
    expect(screen.queryByText("Opening workspace…")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(workspace.id);
    await user.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await waitFor(() => expect(firstBootstrapReads).toBe(2));
    await screen.findByRole("button", { name: /Open run.*Original runner/ });
    await user.click(screen.getByRole("button", { name: "Switch to Second" }));
    await screen.findByRole("button", { name: /Open run.*Second runner/ });
    expect(secondAttempts).toBe(2);
    expect(window.localStorage.getItem("nexestra.workspaceId")).toBe(secondWorkspace.id);
    expect(screen.queryByText("Second workspace unavailable")).not.toBeInTheDocument();
  });

  it("aborts run history immediately on a workspace switch and ignores the old response", async () => {
    const first = activityThread("run-history-workspace-first", "First history");
    const secondWorkspace = { ...workspace, id: "run-history-second-workspace", name: "Second" };
    const second = {
      ...activityThread("run-history-workspace-second", "Second history"),
      workspaceId: secondWorkspace.id,
    };
    const secondAgent = {
      ...workerAgent,
      id: "second-runner",
      workspaceId: secondWorkspace.id,
      name: "Second runner",
    };
    const firstRun = activityRun(first, "failed");
    const secondRun = { ...activityRun(second, "interrupted"), agentId: secondAgent.id };
    const firstRequest = deferredResponse();
    const secondBootstrap = deferredResponse();
    let firstSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        if (path.includes(secondWorkspace.id)) return secondBootstrap.promise;
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, secondWorkspace],
          agents: [workerAgent],
          threads: [first],
        });
      }
      if (path.startsWith("/api/runs?")) {
        if (path.includes(secondWorkspace.id))
          return jsonResponse(listing(second, secondRun, secondAgent.name));
        firstSignal = init?.signal;
        return firstRequest.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/runs");
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() => expect(firstSignal).toBeDefined());
    await user.click(screen.getByRole("button", { name: "Switch to Second" }));
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByText("Opening workspace…")).toBeInTheDocument();
    await act(async () => {
      firstRequest.resolve(jsonResponse(listing(first, firstRun, "Stale first runner")));
    });
    expect(screen.queryByText("Stale first runner")).not.toBeInTheDocument();
    await act(async () => {
      secondBootstrap.resolve(
        jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, secondWorkspace],
          workspace: secondWorkspace,
          agents: [secondAgent],
          threads: [second],
        }),
      );
    });
    await screen.findByRole("button", { name: /Open run.*Second runner/ });
    expect(window.location.pathname).toBe("/surfaces/runs");
    expect(screen.queryByText("Stale first runner")).not.toBeInTheDocument();
  });
});

describe("Unread conversation UI", () => {
  type VisibilityEntry = { isIntersecting: boolean };
  type VisibilityCallback = (entries: VisibilityEntry[]) => void;
  const observerCallbacks: VisibilityCallback[] = [];
  const previousVisibility = document.visibilityState;

  class MockIntersectionObserver {
    observe = vi.fn();
    disconnect = vi.fn();
    constructor(readonly callback: VisibilityCallback) {
      observerCallbacks.push(callback);
    }
  }

  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let sentinelTop = 0;
  function testRect(top: number, bottom: number): DOMRect {
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

  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    sentinelTop = 400;
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function exactRect() {
      if (this.classList.contains("message-scroll")) {
        return testRect(0, 100);
      }
      if (this.classList.contains("latest-bottom-sentinel")) {
        return testRect(sentinelTop, sentinelTop);
      }
      return testRect(0, 0);
    };
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    observerCallbacks.length = 0;
    sentinelTop = 400;
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: previousVisibility,
    });
  });

  function unreadKey(workspaceId: string): string {
    return `nexestra.readState.1.${workspaceId}`;
  }

  function storedReadCount(threadId: string): number | undefined {
    const raw = window.localStorage.getItem(unreadKey(workspace.id));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { counts?: Record<string, number> };
    return parsed.counts?.[threadId];
  }

  function atHistoryUrl(thread: Thread, index: number): string {
    return `${historyUrl(thread)}&at=${index}`;
  }

  function withUnreadTarget(page: ThreadHistoryPage, index: number): ThreadHistoryPage {
    return {
      ...page,
      page: {
        ...page.page,
        targetFound: true,
        targetMessageId: `message-unread-${index}`,
        targetMessageIndex: index,
      },
    };
  }

  function latestMessagePage(
    thread: Thread,
    content = "Hello",
    total = 1,
    firstMessageIndex = 1,
    loaded = 1,
  ): ThreadHistoryPage {
    const messages = Array.from({ length: loaded }, (_, offset) => {
      const sequence = firstMessageIndex + offset;
      return {
        id: `message-unread-${sequence}`,
        threadId: thread.id,
        sequence,
        author: { kind: "user" as const, id: "local-user" as const, name: "You" },
        content: offset === 0 ? content : `${content} ${sequence}`,
        mentions: [],
        knowledgeReferences: [],
        artifactIds: [],
        createdAt: now,
      };
    });
    return {
      thread,
      messages,
      artifacts: [],
      runs: [],
      activeRuns: [],
      toolCalls: [],
      page: {
        totalMessages: total,
        totalArtifacts: 0,
        firstMessageIndex: total > 0 ? firstMessageIndex : 0,
        lastMessageIndex: total > 0 ? Math.min(total, firstMessageIndex + loaded - 1) : 0,
        targetFound: true,
        beforeCursor: null,
        afterCursor: null,
      },
    };
  }

  it("keeps filter and selected files per workspace during navigation and resets the filter on remount", async () => {
    const first = activityThread("workspace-filter-first", "Alpha");
    const secondWorkspace = { ...workspace, id: "second-filter-workspace", name: "Second" };
    const second = {
      ...activityThread("workspace-filter-second", "Beta"),
      workspaceId: secondWorkspace.id,
    };
    for (const thread of [first, second]) {
      window.localStorage.setItem(
        unreadKey(thread.workspaceId),
        JSON.stringify({ version: 1, workspaceId: thread.workspaceId, counts: { [thread.id]: 0 } }),
      );
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        const other = path.includes(secondWorkspace.id);
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, secondWorkspace],
          workspace: other ? secondWorkspace : workspace,
          threads: [other ? second : first],
        });
      }
      const thread = [first, second].find((entry) => path === historyUrl(entry));
      if (thread) return jsonResponse(latestMessagePage(thread));
      const unread = [first, second].find((entry) => path === atHistoryUrl(entry, 1));
      if (unread) return jsonResponse(withUnreadTarget(latestMessagePage(unread), 1));
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${first.id}`);
    const user = userEvent.setup();
    const view = render(<App />);
    await user.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "First workspace draft",
    );
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["first"], "first-workspace.txt"),
    );
    await user.click(screen.getByRole("button", { name: "Unread conversations" }));
    await user.click(screen.getByRole("button", { name: "Switch to Second" }));
    await screen.findByRole("heading", { name: "# Beta" });
    expect(screen.getByRole("button", { name: "All conversations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByText("first-workspace.txt")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Surfaces" }));
    await user.type(
      screen.getByRole("combobox", { name: "Search threads, tasks, agents, or knowledge" }),
      "/next unread",
    );
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "# Beta" });
    expect(window.location.pathname).toBe(`/threads/${second.id}`);
    await user.click(screen.getByRole("button", { name: "Switch to Nexestra" }));
    await screen.findByRole("heading", { name: "# Alpha" });
    expect(screen.getByRole("button", { name: "Unread conversations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("First workspace draft");
    expect(screen.getByText("first-workspace.txt")).toBeInTheDocument();
    view.unmount();
    render(<App />);
    await screen.findByRole("heading", { name: "# Alpha" });
    expect(screen.getByRole("button", { name: "All conversations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("First workspace draft");
    expect(screen.queryByText("first-workspace.txt")).not.toBeInTheDocument();
  });

  it("filters locally, retains the current read conversation, and keeps composer files", async () => {
    const first = activityThread("filter-current", "Alpha");
    const read = activityThread("filter-read", "Already read");
    const archived = { ...activityThread("filter-archive", "Archived unread"), archived: true };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: {
          [first.id]: 0,
          [read.id]: 1,
          [archived.id]: 0,
        },
      }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, threads: [first, read, archived] });
      }
      if (String(input) === historyUrl(first)) return jsonResponse(latestMessagePage(first));
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${first.id}`);
    const user = userEvent.setup();
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Keep this draft");
    const file = new File(["File stays in this tab"], "filter.txt", { type: "text/plain" });
    await user.upload(screen.getByLabelText("Choose files or images"), file);
    const requests = fetchMock.mock.calls.length;
    const unread = screen.getByRole("button", { name: "Unread conversations" });
    await user.click(unread);
    expect(unread).toHaveAttribute("aria-pressed", "true");
    expect(unread).toHaveFocus();
    expect(screen.queryByRole("button", { name: /#Already read/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /#Archived unread/ })).toBeInTheDocument();
    expect(storedReadCount(first.id)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(requests);

    sentinelTop = 50;
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(storedReadCount(first.id)).toBe(1));
    expect(screen.getByRole("button", { name: /#Alpha/ })).toHaveClass("selected");
    expect(unread).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Mark all conversations read" }));
    expect(
      screen.getByText("No unread conversations. Current conversation stays visible."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /#Archived unread/ })).not.toBeInTheDocument();
    expect(screen.queryByText("No active threads. Create one →")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next unread conversation" })).toBeDisabled();
    expect(composer).toHaveValue("Keep this draft");
    expect(screen.getByText("filter.txt")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    await user.click(screen.getByRole("button", { name: "All conversations" }));
    expect(screen.getByRole("button", { name: /#Already read/ })).toBeInTheDocument();
  });

  it("cycles unread in sidebar order including archived and preserves files across navigation", async () => {
    const first = activityThread("next-first", "Alpha");
    const second = activityThread("next-second", "Beta");
    const archived = { ...activityThread("next-archived", "Gamma"), archived: true };
    // Metadata order deliberately differs from the active-then-archived sidebar order.
    const threads = [archived, first, second];
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: {
          [first.id]: 0,
          [second.id]: 0,
          [archived.id]: 0,
        },
      }),
    );
    const pendingKey = `nexestra.pendingSubmission.1.${workspace.id}:${first.id}`;
    const pending = JSON.stringify({
      version: 1,
      requestId: "12345678-1234-4123-8123-123456789012",
      key: `v1:${"a".repeat(64)}`,
      files: [],
      createdAt: now,
    });
    window.localStorage.setItem(pendingKey, pending);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads });
      const thread = threads.find((entry) => String(input) === historyUrl(entry));
      if (thread) return jsonResponse(latestMessagePage(thread, `Message in ${thread.name}`));
      const unread = threads.find((entry) => String(input) === atHistoryUrl(entry, 1));
      if (unread)
        return jsonResponse(
          withUnreadTarget(latestMessagePage(unread, `Message in ${unread.name}`), 1),
        );
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${first.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "Return to this draft",
    );
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["Payload"], "navigation.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByRole("button", { name: "Unread conversations" }));
    await user.click(screen.getByRole("button", { name: "Next unread conversation" }));
    await screen.findByRole("heading", { name: "# Beta" });
    expect(screen.queryByText("navigation.txt")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next unread conversation" }));
    await screen.findByRole("heading", { name: "# Gamma" });
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Message" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next unread conversation" }));
    expect(await screen.findByRole("combobox", { name: "Message" })).toHaveValue(
      "Return to this draft",
    );
    expect(screen.getByText("navigation.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unread conversations" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(window.localStorage.getItem(pendingKey)).toBe(pending);
    expect(
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/history")),
    ).toEqual([
      historyUrl(first),
      atHistoryUrl(second, 1),
      atHistoryUrl(archived, 1),
      atHistoryUrl(first, 1),
    ]);
  });

  it("opens the only unread conversation at its first unread message from Files and coalesces pending requests", async () => {
    const thread = { ...activityThread("next-current", "Alpha"), messageCount: 2 };
    const oldPage = latestMessagePage(thread, "Linked message", 2);
    const latestPage = latestMessagePage(thread, "Latest reply", 2, 2);
    let resolveUnread!: (value: Response) => void;
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({ version: 1, workspaceId: workspace.id, counts: { [thread.id]: 0 } }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread, "message-unread-1")) return jsonResponse(oldPage);
      if (path === `/api/threads/${thread.id}`) return jsonResponse(oldPage);
      if (path === historyUrl(thread)) return jsonResponse(latestPage);
      if (path === atHistoryUrl(thread, 1))
        return new Promise<Response>((resolve) => {
          resolveUnread = resolve;
        });
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-unread-1`);
    const user = userEvent.setup();
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Keep current draft");
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["keep"], "current.txt"),
    );
    await user.click(screen.getByRole("button", { name: /Files & links/ }));
    await screen.findByText("No files or links yet");
    sentinelTop = 50;
    await user.type(
      screen.getByRole("combobox", { name: "Search threads, tasks, agents, or knowledge" }),
      "/next unread",
    );
    await user.keyboard("{Enter}");
    expect(window.location.search).toBe("?message=message-unread-1");
    expect(screen.queryByText("No files or links yet")).not.toBeInTheDocument();
    expect(storedReadCount(thread.id)).toBe(0);
    const historyLength = window.history.length;
    await user.click(screen.getByRole("button", { name: "Next unread conversation" }));
    expect(window.history.length).toBe(historyLength);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === atHistoryUrl(thread, 1)),
    ).toHaveLength(1);
    await act(async () => {
      resolveUnread(jsonResponse(withUnreadTarget(oldPage, 1)));
    });
    await screen.findByText("Opened at the first unread message.");
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Selected message" })).toHaveFocus(),
    );
    expect(storedReadCount(thread.id)).toBe(0);
    expect(window.history.length).toBe(historyLength);
    await user.click(screen.getByRole("button", { name: "Show latest" }));
    await screen.findByText("Latest reply");
    await waitFor(() => expect(storedReadCount(thread.id)).toBe(2));
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Keep current draft");
    expect(screen.getByText("current.txt")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === historyUrl(thread)),
    ).toHaveLength(1);
  });

  it("resolves a long unread backlog once, refreshes by stable message ID, and marks only the current conversation read", async () => {
    const thread = { ...activityThread("first-unread-backlog", "Alpha"), messageCount: 140 };
    const other = { ...activityThread("first-unread-other", "Beta"), messageCount: 4 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 20, [other.id]: 0 },
      }),
    );
    const latest = latestMessagePage(thread, "Recent", 140, 91, 50);
    const firstUnread = withUnreadTarget(latestMessagePage(thread, "Catch up", 140, 1, 50), 21);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread, other] });
      if (path === historyUrl(thread)) return jsonResponse(latest);
      if (path === atHistoryUrl(thread, 21) || path === historyUrl(thread, "message-unread-21"))
        return jsonResponse(firstUnread);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("combobox", { name: "Message" }), "Backlog draft");
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["keep"], "backlog.txt"),
    );
    sentinelTop = 50;
    await user.click(screen.getByRole("button", { name: "First unread message" }));
    const selected = await screen.findByRole("region", { name: "Selected message" });
    expect(within(selected).getByText("Catch up 21")).toBeInTheDocument();
    await waitFor(() => expect(selected).toHaveFocus());
    expect(window.location.search).toBe("?message=message-unread-21");
    expect(storedReadCount(thread.id)).toBe(20);
    expect(
      fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((path) => path.includes("/history")),
    ).toEqual([historyUrl(thread), atHistoryUrl(thread, 21)]);

    await user.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => String(input) === historyUrl(thread, "message-unread-21"),
        ),
      ).toHaveLength(1),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh workspace" })).toBeEnabled(),
    );
    expect(storedReadCount(thread.id)).toBe(20);
    const requests = fetchMock.mock.calls.length;
    const historyLength = window.history.length;
    await user.click(screen.getByRole("button", { name: "Mark conversation read" }));
    expect(storedReadCount(thread.id)).toBe(140);
    expect(storedReadCount(other.id)).toBe(0);
    expect(window.location.search).toBe("?message=message-unread-21");
    expect(window.history.length).toBe(historyLength);
    expect(screen.getByRole("region", { name: "Selected message" })).toHaveTextContent(
      "Catch up 21",
    );
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Backlog draft");
    expect(screen.getByText("backlog.txt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "First unread message" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it.each([false, true])(
    "marks the current Files view's known total read despite lagging metadata (archived: %s)",
    async (archived) => {
      const thread = {
        ...activityThread("mark-current-files", "Alpha"),
        messageCount: 3,
        archived,
      };
      const other = activityThread("mark-current-other", "Beta");
      window.localStorage.setItem(
        unreadKey(workspace.id),
        JSON.stringify({
          version: 1,
          workspaceId: workspace.id,
          counts: { [thread.id]: 0, [other.id]: 0 },
        }),
      );
      const page = latestMessagePage(thread, "Old selected message", 4);
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.startsWith("/api/bootstrap"))
          return jsonResponse({ ...bootstrapData, threads: [thread, other] });
        if (path === historyUrl(thread, "message-unread-1") || path === `/api/threads/${thread.id}`)
          return jsonResponse(page);
        return jsonResponse({ error: { message: "Not found" } }, 404);
      });
      vi.stubGlobal("fetch", fetchMock);
      window.history.replaceState({}, "", `/threads/${thread.id}?message=message-unread-1`);
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole("button", { name: /Files & links/ }));
      await screen.findByText("No files or links yet");
      await user.click(screen.getByRole("button", { name: "Unread conversations" }));
      const requests = fetchMock.mock.calls.length;
      await user.type(
        screen.getByRole("combobox", { name: "Search threads, tasks, agents, or knowledge" }),
        "/mark read",
      );
      await user.keyboard("{Enter}");
      expect(storedReadCount(thread.id)).toBe(4);
      expect(storedReadCount(other.id)).toBe(0);
      expect(screen.getByText("No files or links yet")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /#Alpha/ })).toHaveClass("selected");
      expect(screen.getByRole("button", { name: "Mark conversation read" })).toBeDisabled();
      expect(window.location.search).toBe("?message=message-unread-1");
      expect(fetchMock).toHaveBeenCalledTimes(requests);
    },
  );

  it.each([
    ["/first unread", "Open a conversation to find its first unread message."],
    ["/mark read", "Open a conversation to mark it read."],
  ])("handles %s without a current conversation locally", async (command, notice) => {
    const thread = activityThread("no-current-unread", "Alpha");
    const fetchMock = vi.fn(async () => jsonResponse({ ...bootstrapData, threads: [thread] }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/taskboard");
    const user = userEvent.setup();
    render(<App />);
    const search = await screen.findByRole("combobox", {
      name: "Search threads, tasks, agents, or knowledge",
    });
    const requests = fetchMock.mock.calls.length;
    await user.type(search, command);
    await user.keyboard("{Enter}");
    expect(screen.getByText(notice)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/surfaces/taskboard");
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it("retries a failed first-unread lookup without losing the existing anchor or draft", async () => {
    const thread = { ...activityThread("first-unread-retry", "Alpha"), messageCount: 5 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 2 },
      }),
    );
    let attempts = 0;
    const page = latestMessagePage(thread, "Catch up", 5, 1, 5);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread, "message-unread-1")) return jsonResponse(page);
      if (path === atHistoryUrl(thread, 3)) {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: { message: "Unread history unavailable" } }, 503)
          : jsonResponse(withUnreadTarget(page, 3));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-unread-1`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("combobox", { name: "Message" }), "Keep retry draft");
    await user.click(screen.getByRole("button", { name: "First unread message" }));
    await screen.findByText("Unread history unavailable");
    expect(window.location.search).toBe("?message=message-unread-1");
    expect(storedReadCount(thread.id)).toBe(2);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Opened at the first unread message.");
    expect(window.location.search).toBe("?message=message-unread-3");
    expect(storedReadCount(thread.id)).toBe(2);
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("Keep retry draft");
    expect(attempts).toBe(2);
  });

  it("reports an unavailable unread ordinal without treating the fallback page as read", async () => {
    const thread = { ...activityThread("first-unread-missing", "Alpha"), messageCount: 140 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 120 },
      }),
    );
    const oldPage = latestMessagePage(thread, "Original selection", 140);
    const fallback = latestMessagePage(thread, "Recent fallback", 140, 91, 50);
    fallback.page.targetFound = false;
    fallback.page.targetMessageIndex = 121;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread, "message-unread-1")) return jsonResponse(oldPage);
      if (path === atHistoryUrl(thread, 121)) return jsonResponse(fallback);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-unread-1`);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("Original selection");
    sentinelTop = 50;
    await user.click(screen.getByRole("button", { name: "First unread message" }));
    await screen.findByText(
      "The first unread message is no longer available. Showing recent messages.",
    );
    expect(screen.getByText("Recent fallback")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Selected message" })).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(storedReadCount(thread.id)).toBe(120);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/history")),
    ).toHaveLength(2);
  });

  it("ignores a delayed unread lookup after Show latest supersedes it", async () => {
    const thread = { ...activityThread("first-unread-stale", "Alpha"), messageCount: 140 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 20 },
      }),
    );
    let resolveUnread!: (response: Response) => void;
    let unreadSignal: AbortSignal | null | undefined;
    const latest = latestMessagePage(thread, "Recent conversation", 140, 91, 50);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread)) return jsonResponse(latest);
      if (path === atHistoryUrl(thread, 21)) {
        unreadSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveUnread = resolve;
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "First unread message" }));
    await user.click(screen.getByRole("button", { name: "Show latest" }));
    expect(unreadSignal?.aborted).toBe(true);
    await act(async () => {
      resolveUnread(
        jsonResponse(withUnreadTarget(latestMessagePage(thread, "Stale unread", 140, 1, 50), 21)),
      );
    });
    expect(screen.getByText("Recent conversation")).toBeInTheDocument();
    expect(screen.queryByText("Stale unread")).not.toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(storedReadCount(thread.id)).toBe(20);
  });

  it("uses the current cross-tab marker for a queued first-unread command", async () => {
    const thread = { ...activityThread("first-unread-fresh", "Alpha"), messageCount: 10 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 2 },
      }),
    );
    const page = latestMessagePage(thread, "Current unread", 10, 1, 10);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread)) return jsonResponse(page);
      if (path === atHistoryUrl(thread, 7)) return jsonResponse(withUnreadTarget(page, 7));
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByRole("combobox", { name: "Search threads, tasks, agents, or knowledge" }),
      "/first unread",
    );
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: unreadKey(workspace.id),
          newValue: JSON.stringify({
            version: 1,
            workspaceId: workspace.id,
            counts: { [thread.id]: 6 },
          }),
        }),
      );
    });
    await user.keyboard("{Enter}");
    await screen.findByText("Opened at the first unread message.");
    expect(window.location.search).toBe("?message=message-unread-7");
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === atHistoryUrl(thread, 3)),
    ).toHaveLength(0);
  });

  it("does not replace Back to an identical URL with a delayed unread link", async () => {
    const thread = { ...activityThread("first-unread-back", "Alpha"), messageCount: 4 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 1 },
      }),
    );
    let resolveUnread!: (response: Response) => void;
    let unreadSignal: AbortSignal | null | undefined;
    const page = latestMessagePage(thread, "Back destination", 4, 1, 4);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread)) return jsonResponse(page);
      if (path === atHistoryUrl(thread, 2)) {
        unreadSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveUnread = resolve;
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /#Alpha/ }));
    await user.click(await screen.findByRole("button", { name: "First unread message" }));
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(unreadSignal?.aborted).toBe(true));
    await act(async () => {
      resolveUnread(jsonResponse(withUnreadTarget(page, 2)));
    });
    expect(window.location.pathname).toBe(`/threads/${thread.id}`);
    expect(window.location.search).toBe("");
    expect(screen.queryByText("Opened at the first unread message.")).not.toBeInTheDocument();
    expect(screen.getByText("Back destination")).toBeInTheDocument();
    expect(storedReadCount(thread.id)).toBe(1);
  });

  it("ignores an unread response after switching workspaces and keeps the original draft", async () => {
    const thread = { ...activityThread("first-unread-workspace", "Alpha"), messageCount: 4 };
    const otherWorkspace = { ...workspace, id: "first-unread-foreign", name: "Second" };
    const other = {
      ...activityThread("first-unread-foreign-thread", "Beta"),
      workspaceId: otherWorkspace.id,
    };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 1 },
      }),
    );
    let resolveUnread!: (response: Response) => void;
    let unreadSignal: AbortSignal | null | undefined;
    const page = latestMessagePage(thread, "Original workspace", 4, 1, 4);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        const foreign = path.includes(otherWorkspace.id);
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, otherWorkspace],
          workspace: foreign ? otherWorkspace : workspace,
          threads: [foreign ? other : thread],
        });
      }
      if (path === historyUrl(thread)) return jsonResponse(page);
      if (path === historyUrl(other))
        return jsonResponse(latestMessagePage(other, "Other workspace"));
      if (path === atHistoryUrl(thread, 2)) {
        unreadSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveUnread = resolve;
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("combobox", { name: "Message" }), "Workspace draft");
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["workspace"], "workspace.txt"),
    );
    await user.click(screen.getByRole("button", { name: "First unread message" }));
    await user.click(screen.getByRole("button", { name: "Switch to Second" }));
    await screen.findByText("Other workspace");
    expect(unreadSignal?.aborted).toBe(true);
    await act(async () => {
      resolveUnread(jsonResponse(withUnreadTarget(page, 2)));
    });
    expect(window.location.pathname).toBe(`/threads/${other.id}`);
    expect(window.location.search).toBe("");
    expect(screen.getByText("Other workspace")).toBeInTheDocument();
    expect(screen.queryByText("workspace.txt")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to Nexestra" }));
    expect(await screen.findByRole("combobox", { name: "Message" })).toHaveValue("Workspace draft");
    expect(screen.getByText("workspace.txt")).toBeInTheDocument();
    expect(storedReadCount(thread.id)).toBe(1);
  });

  it("uses current cross-tab read markers when a queued next-unread command is selected", async () => {
    const thread = activityThread("next-fresh", "Alpha");
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({ version: 1, workspaceId: workspace.id, counts: { [thread.id]: 0 } }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (String(input) === historyUrl(thread)) return jsonResponse(latestMessagePage(thread));
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    await user.type(
      screen.getByRole("combobox", { name: "Search threads, tasks, agents, or knowledge" }),
      "/next unread",
    );
    const requests = fetchMock.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: unreadKey(workspace.id),
          newValue: JSON.stringify({
            version: 1,
            workspaceId: workspace.id,
            counts: { [thread.id]: 1 },
          }),
        }),
      );
    });
    await user.keyboard("{Enter}");
    expect(screen.getByText("No unread conversations in this workspace.")).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/threads/${thread.id}`);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  });

  it("shows per-thread and aggregate unread counts and marks all conversations read", async () => {
    const first = { ...activityThread("thread-unread-first", "Alpha"), messageCount: 5 };
    const second = { ...activityThread("thread-unread-second", "Beta"), messageCount: 3 };
    const archived = {
      ...activityThread("thread-unread-archived", "Gamma"),
      messageCount: 2,
      archived: true,
    };
    const key = unreadKey(workspace.id);
    window.localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [first.id]: 0, [second.id]: 0, [archived.id]: 0 },
      }),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [first, second, archived],
        });
      }
      if (path === historyUrl(first)) return jsonResponse(threadSnapshot(first, []));
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${first.id}`);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });

    expect(screen.getByRole("img", { name: "5 unread messages" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "3 unread messages" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "2 unread messages" })).toBeInTheDocument();
    const markAll = screen.getByRole("button", { name: "Mark all conversations read" });
    expect(markAll).toBeEnabled();

    await userEvent.click(markAll);
    await waitFor(() => {
      expect(screen.queryByRole("img", { name: "5 unread messages" })).not.toBeInTheDocument();
      expect(storedReadCount(first.id)).toBe(5);
      expect(storedReadCount(second.id)).toBe(3);
      expect(storedReadCount(archived.id)).toBe(2);
    });
  });

  it("acknowledges the loaded latest bottom and preserves draft and attachments", async () => {
    const thread = activityThread("thread-unread-ack", "Alpha");
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 0 },
      }),
    );
    const page = latestMessagePage(thread);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
      }
      if (path === historyUrl(thread)) return jsonResponse(page);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "Draft before ack");
    const fileInput = screen.getByLabelText("Choose files or images");
    await user.upload(fileInput, new File(["# Notes"], "notes.md", { type: "text/markdown" }));
    expect(screen.getByText("notes.md")).toBeInTheDocument();

    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: false }]);
    });
    expect(storedReadCount(thread.id)).toBe(0);
    sentinelTop = 50;
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(storedReadCount(thread.id)).toBe(1));
    expect(screen.queryByRole("img", { name: "1 unread messages" })).not.toBeInTheDocument();
    expect(composer).toHaveValue("Draft before ack");
    expect(screen.getByText("notes.md")).toBeInTheDocument();
  });

  it("never acknowledges hidden, unfocused, or newer-unloaded counts", async () => {
    const thread = { ...activityThread("thread-unread-gated", "Alpha"), messageCount: 5 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 0 },
      }),
    );
    const page = latestMessagePage(thread, "Hello", 5);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
      }
      if (path === historyUrl(thread)) return jsonResponse(page);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    await screen.findByRole("button", { name: "Older messages" });

    sentinelTop = 50;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    expect(storedReadCount(thread.id)).toBe(0);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    expect(storedReadCount(thread.id)).toBe(0);

    vi.mocked(document.hasFocus).mockReturnValue(true);
    sentinelTop = 50;
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(storedReadCount(thread.id)).toBe(1));
    expect(screen.getAllByRole("img", { name: "4 unread messages" })).toHaveLength(2);
  });

  it("does not acknowledge an around page opened by a deep link", async () => {
    const thread = { ...activityThread("thread-unread-around", "Alpha"), messageCount: 2 };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 0 },
      }),
    );
    const aroundPage = latestMessagePage(thread, "Linked", 2, 1, 1);
    const latestPage = latestMessagePage(thread, "Latest", 2, 1, 2);
    let resolveLatest: (value: ThreadHistoryPage) => void = () => {};
    const latestResponse = new Promise<ThreadHistoryPage>((resolve) => {
      resolveLatest = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
      }
      if (path === historyUrl(thread, "message-unread-1")) {
        return jsonResponse(aroundPage);
      }
      if (path === historyUrl(thread)) return jsonResponse(await latestResponse);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-unread-1`);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    await screen.findByText("Viewing a linked message.");

    sentinelTop = 50;
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    expect(storedReadCount(thread.id)).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Show latest" }));
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    expect(storedReadCount(thread.id)).toBe(0);
    sentinelTop = 50;
    await act(async () => {
      resolveLatest(latestPage);
    });
    await waitFor(() => expect(storedReadCount(thread.id)).toBe(2));
  });

  it("acknowledges a full latest page spanning more than one scroll window", async () => {
    const thread = {
      ...activityThread("thread-unread-seventy", "Alpha"),
      messageCount: 70,
    };
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 0 },
      }),
    );
    const page = latestMessagePage(thread, "Seventy", 70, 21, 50);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
      }
      if (path === historyUrl(thread)) return jsonResponse(page);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    sentinelTop = 50;
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(storedReadCount(thread.id)).toBe(70));
    expect(screen.queryByRole("img", { name: /unread messages/ })).not.toBeInTheDocument();
  });

  it("shows a tab-only note when read-state storage is unavailable", async () => {
    const thread = activityThread("thread-unread-storage", "Alpha");
    const threads = [thread];
    const page = latestMessagePage(thread);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads });
      }
      if (path === historyUrl(thread)) return jsonResponse(page);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    expect(
      screen.getByText(/Unread counts stay in this tab until you close it/i),
    ).toBeInTheDocument();
    write.mockRestore();
    threads.push(activityThread("thread-storage-recovered", "Recovered"));
    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await waitFor(() => {
      expect(
        screen.queryByText(/Unread counts stay in this tab until you close it/i),
      ).not.toBeInTheDocument();
      expect(storedReadCount("thread-storage-recovered")).toBe(0);
    });
  });

  it("waits for a modal to close before acknowledging the visible bottom", async () => {
    const thread = activityThread("thread-unread-modal", "Alpha");
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [thread.id]: 0 },
      }),
    );
    const page = latestMessagePage(thread);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [thread] });
      }
      if (path === historyUrl(thread)) return jsonResponse(page);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });

    await user.click(screen.getByRole("button", { name: "Create thread" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    sentinelTop = 50;
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    expect(storedReadCount(thread.id)).toBe(0);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    sentinelTop = 50;
    await act(async () => {
      observerCallbacks.at(-1)?.([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(storedReadCount(thread.id)).toBe(1));
  });

  it("ignores an old observer after switching threads and Files & links", async () => {
    const first = activityThread("thread-unread-old", "Alpha");
    const second = activityThread("thread-unread-new", "Beta");
    window.localStorage.setItem(
      unreadKey(workspace.id),
      JSON.stringify({
        version: 1,
        workspaceId: workspace.id,
        counts: { [first.id]: 0, [second.id]: 0 },
      }),
    );
    const firstPage = latestMessagePage(first, "First");
    let secondPage = latestMessagePage(second, "Second");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, agents: [workerAgent], threads: [first, second] });
      }
      if (path === historyUrl(first)) return jsonResponse(firstPage);
      if (path === historyUrl(second)) return jsonResponse(secondPage);
      if (path === `/api/threads/${second.id}`) return jsonResponse(secondPage);
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${first.id}`);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("combobox", { name: "Message" });
    const oldCallback = observerCallbacks.at(-1);
    if (!oldCallback) throw new Error("The first transcript observer did not mount");

    await user.click(screen.getByRole("button", { name: /#Beta/ }));
    await screen.findByRole("heading", { name: "# Beta" });
    const newCallback = observerCallbacks.at(-1);
    if (!newCallback) throw new Error("The second transcript observer did not mount");
    sentinelTop = 50;
    await act(async () => {
      oldCallback([{ isIntersecting: true }]);
    });
    expect(storedReadCount(first.id)).toBe(0);
    expect(storedReadCount(second.id)).toBe(0);

    sentinelTop = 50;
    await act(async () => {
      newCallback([{ isIntersecting: true }]);
    });
    await waitFor(() => expect(storedReadCount(second.id)).toBe(1));
    expect(storedReadCount(first.id)).toBe(0);

    await user.click(screen.getByRole("button", { name: /Files & links/ }));
    await screen.findByText("No files or links yet");
    second.messageCount = 2;
    secondPage = latestMessagePage(second, "New message in Files view", 2, 1, 2);
    await user.click(screen.getByRole("button", { name: "Refresh workspace" }));
    await waitFor(() => {
      expect(
        within(screen.getByRole("button", { name: /#Beta/ })).getByRole("img", {
          name: "1 unread messages",
        }),
      ).toBeInTheDocument();
    });
    await act(async () => {
      newCallback([{ isIntersecting: true }]);
    });
    expect(storedReadCount(second.id)).toBe(1);
    expect(
      within(screen.getByRole("button", { name: /#Beta/ })).getByRole("img", {
        name: "1 unread messages",
      }),
    ).toBeInTheDocument();
  });
});
