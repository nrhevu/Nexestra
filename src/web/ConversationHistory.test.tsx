// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRun,
  AgentView,
  Artifact,
  AttentionItem,
  BootstrapData,
  Message,
  Thread,
  ThreadData,
  ThreadHistoryPage,
} from "../shared/contracts.js";
import { runAttentionItem, THREAD_HISTORY_DEFAULT_LIMIT } from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-02T12:00:00.000Z";
const workspace = {
  id: "workspace-notes",
  name: "Notes",
  slug: "notes",
  createdAt: now,
  updatedAt: now,
};
const otherWorkspace = { ...workspace, id: "workspace-other", name: "Other", slug: "other" };
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
const thread: Thread = {
  id: "thread-history",
  workspaceId: workspace.id,
  name: "History",
  slug: "history",
  createdAt: now,
  updatedAt: now,
  messageCount: 60,
  lastMessageAt: now,
  archived: false,
};
const otherThread: Thread = {
  ...thread,
  id: "thread-other",
  workspaceId: otherWorkspace.id,
  name: "Other",
  slug: "other",
};
const bootstrap: BootstrapData = {
  workspaces: [workspace, otherWorkspace],
  workspace,
  agents: [workerAgent],
  threads: [thread],
  tasks: [],
  knowledge: [],
  assignments: [],
  activeRuns: [],
  attention: [],
  runtime: {
    chatgpt: { installed: true, connected: true, message: "Fixture" },
    harnesses: {
      codex: { installed: true, version: "fixture" },
      opencode: { installed: true, version: "fixture" },
    },
  },
  workspacePath: "/fixture",
  dataPath: "/fixture/.nexestra",
};

function makeMessage(id: string, sequence: number, content: string, createdAt = now): Message {
  return {
    id,
    threadId: thread.id,
    sequence,
    author: { kind: "user", id: "local-user", name: "You" },
    content,
    mentions: [],
    knowledgeReferences: [],
    artifactIds: [],
    createdAt,
  };
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) =>
    makeMessage(`message-${index + 1}`, index + 1, `Message ${index + 1}`),
  );
}

function dayAt(daysAgo: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

const allMessages = makeMessages(60);

function historyPageFor(snapshot: ThreadData, params: URLSearchParams): ThreadHistoryPage {
  const limit = Number(params.get("limit") ?? THREAD_HISTORY_DEFAULT_LIMIT);
  const all = [...snapshot.messages].sort((left, right) => left.sequence - right.sequence);
  const total = all.length;
  let start = Math.max(0, total - limit);
  let end = total;
  let targetMessageId: string | undefined;
  let targetFound: boolean | undefined;
  const before = params.get("before");
  const after = params.get("after");
  const around = params.get("around");
  if (before) {
    const index = all.findIndex((message) => message.id === before);
    start = Math.max(0, index - limit);
    end = index;
  } else if (after) {
    const index = all.findIndex((message) => message.id === after);
    start = Math.min(total, index + 1);
    end = Math.min(total, start + limit);
  } else if (around) {
    const index = all.findIndex((message) => message.id === around);
    if (index === -1) {
      targetMessageId = around;
      targetFound = false;
    } else {
      targetMessageId = around;
      targetFound = true;
      start = Math.max(
        0,
        Math.min(index - Math.floor((limit - 1) / 2), Math.max(0, total - limit)),
      );
      end = Math.min(total, start + limit);
    }
  }
  const pageMessages = all.slice(start, end);
  const pageIds = new Set(pageMessages.map((message) => message.id));
  return {
    thread: snapshot.thread,
    messages: pageMessages,
    artifacts: snapshot.artifacts.filter((artifact) => pageIds.has(artifact.messageId)),
    runs: snapshot.runs,
    toolCalls: snapshot.toolCalls ?? [],
    activeRuns: snapshot.runs,
    page: {
      totalMessages: total,
      totalArtifacts: snapshot.artifacts.length,
      firstMessageIndex: start + 1,
      lastMessageIndex: end,
      beforeCursor: start > 0 ? (pageMessages[0]?.id ?? null) : null,
      afterCursor: end < total ? (pageMessages.at(-1)?.id ?? null) : null,
      ...(targetMessageId === undefined ? {} : { targetMessageId, targetFound }),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function installIntervalTimers() {
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

function mockServer(
  options: {
    messages?: Message[];
    artifacts?: Artifact[];
    runs?: AgentRun[];
    activeRuns?: AgentRun[];
    attention?: AttentionItem[];
    fullMessages?: Message[];
    historyOverrides?: Record<string, (path: string) => Response | Promise<Response> | null>;
    includeSecondThread?: boolean;
  } = {},
) {
  const messages = options.messages ? [...options.messages] : [...allMessages];
  const fullMessages = options.fullMessages ?? messages;
  const artifacts = options.artifacts ?? [];
  const runs = options.runs ?? [];
  const activeRuns = options.activeRuns ?? runs;
  const attention = options.attention ?? [];
  const threadById = new Map([
    [thread.id, thread],
    [otherThread.id, otherThread],
  ]);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.startsWith("/api/bootstrap")) {
      const requested = new URL(path, "http://localhost").searchParams.get("workspaceId");
      const foreign = requested === otherWorkspace.id;
      return jsonResponse({
        ...bootstrap,
        workspace: foreign ? otherWorkspace : workspace,
        threads: options.includeSecondThread
          ? [thread, otherThread]
          : foreign
            ? [otherThread]
            : [thread],
        activeRuns,
        attention,
      });
    }
    const historyMatch = path.match(/^\/api\/threads\/([^/]+)\/history/);
    if (historyMatch) {
      const id = decodeURIComponent(historyMatch[1] ?? "");
      const target = threadById.get(id);
      if (!target) return jsonResponse({ error: { message: "Not found" } }, 404);
      const snapshot: ThreadData = {
        thread: target,
        messages: messages.map((message) => ({ ...message, threadId: id })),
        artifacts,
        runs,
        toolCalls: [],
      };
      const override = options.historyOverrides?.[id];
      if (override) {
        const result = override(path);
        if (result) return result;
      }
      return jsonResponse(historyPageFor(snapshot, new URL(path, "http://localhost").searchParams));
    }
    const metadataMatch = path.match(/^\/api\/threads\/([^/]+)\/metadata/);
    if (metadataMatch) {
      const target = threadById.get(decodeURIComponent(metadataMatch[1] ?? ""));
      return target ? jsonResponse(target) : jsonResponse({ error: { message: "Not found" } }, 404);
    }
    const fullMatch = path.match(/^\/api\/threads\/([^/]+)$/);
    if (fullMatch) {
      const target = threadById.get(decodeURIComponent(fullMatch[1] ?? ""));
      if (!target) return jsonResponse({ error: { message: "Not found" } }, 404);
      const snapshot: ThreadData = {
        thread: target,
        messages: fullMessages.map((message) => ({ ...message, threadId: target.id })),
        artifacts,
        runs,
        toolCalls: [],
      };
      return jsonResponse(snapshot);
    }
    if (path.endsWith("/messages") && init?.method === "POST") {
      const content = JSON.parse(String(init.body)).content as string;
      messages.push(makeMessage(`message-${messages.length + 1}`, messages.length + 1, content));
      return jsonResponse({}, 201);
    }
    return jsonResponse({ error: { message: "Not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock };
}

const scrollIntoView = vi.fn();
const previousScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  scrollIntoView.mockClear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousScroll) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", previousScroll);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

describe("Conversation history pagination", () => {
  it("keeps a finite fifty-message window across older, newer, and latest controls", async () => {
    const user = userEvent.setup();
    mockServer();
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    expect(await screen.findByText("Message 60")).toBeVisible();
    expect(screen.getByText("Messages 11–60 of 60")).toBeInTheDocument();
    expect(screen.queryByText("Message 1")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".message").length).toBe(50);

    await user.click(screen.getByRole("button", { name: /Older messages/ }));
    expect(await screen.findByText("Message 1")).toBeVisible();
    expect(screen.getByText("Message 10")).toBeVisible();
    expect(screen.getByText("Messages 1–10 of 60")).toBeInTheDocument();
    expect(screen.queryByText("Message 60")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".message").length).toBe(10);

    await user.click(screen.getByRole("button", { name: /Newer messages/ }));
    expect(await screen.findByText("Message 60")).toBeVisible();
    expect(screen.getByText("Messages 11–60 of 60")).toBeInTheDocument();
    expect(document.querySelectorAll(".message").length).toBe(50);

    await user.click(screen.getByRole("button", { name: "Show latest" }));
    expect(await screen.findByText("Messages 11–60 of 60")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });

  it("opens an old target outside the latest window from a durable link", async () => {
    mockServer();
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-5`);
    render(<App />);

    const selected = await screen.findByRole("region", { name: "Selected message" });
    expect(within(selected).getByText("Message 5")).toBeVisible();
    expect(selected).toHaveFocus();
    expect(window.location.search).toBe("?message=message-5");
  });

  it("reports an unavailable target and falls back to the latest window", async () => {
    mockServer();
    window.history.replaceState({}, "", `/threads/${thread.id}?message=missing`);
    render(<App />);

    await screen.findByText("The linked message is not available in this thread.");
    expect(screen.queryByRole("region", { name: "Selected message" })).not.toBeInTheDocument();
    expect(screen.getByText("Message 60")).toBeVisible();
  });

  it("does not let Show latest on a bare thread suppress the next thread load", async () => {
    const user = userEvent.setup();
    mockServer({ includeSecondThread: true });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Messages 11–60 of 60");
    await user.click(screen.getByRole("button", { name: /Older messages/ }));
    await screen.findByText("Messages 1–10 of 60");
    await user.click(screen.getByRole("button", { name: "Show latest" }));
    await screen.findByText("Messages 11–60 of 60");

    await user.click(screen.getByRole("button", { name: /^#Other/ }));
    expect(await screen.findByRole("heading", { name: "# Other" })).toBeVisible();
    expect(screen.getByText("Message 60")).toBeVisible();
    expect(window.location.pathname).toBe(`/threads/${otherThread.id}`);
  });

  it("retries the failed Older intent instead of the previous page", async () => {
    const user = userEvent.setup();
    let failOlder = false;
    const historyOverrides = {
      [thread.id]: (path: string) => {
        if (path.includes("before=") && failOlder) {
          return jsonResponse({ error: { message: "History exploded." } }, 500);
        }
        return null;
      },
    };
    mockServer({ historyOverrides });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Messages 11–60 of 60");
    failOlder = true;
    await user.click(screen.getByRole("button", { name: /Older messages/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History exploded.");
    expect(screen.getByRole("button", { name: /Older messages/ })).toBeEnabled();

    failOlder = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Message 1")).toBeVisible();
    expect(screen.getByText("Messages 1–10 of 60")).toBeInTheDocument();
  });

  it("lets a quiet poll share the pending Older intent and keeps the old page after it resolves", async () => {
    const user = userEvent.setup();
    const timers = installIntervalTimers();
    const run: AgentRun = {
      id: "run-poll",
      threadId: thread.id,
      triggerMessageId: "message-2",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    const pendings: ReturnType<typeof deferredResponse>[] = [];
    const historyOverrides = {
      [thread.id]: (path: string) => {
        if (path.includes("before=")) {
          const pending = deferredResponse();
          pendings.push(pending);
          return pending.promise;
        }
        return null;
      },
    };
    const { fetchMock } = mockServer({
      runs: [run],
      activeRuns: [run],
      historyOverrides,
    });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Messages 11–60 of 60");
    await user.click(screen.getByRole("button", { name: /Older messages/ }));
    await act(async () => {});
    await timers.tick();
    await act(async () => {});

    const olderRequests = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("before="),
    );
    expect(olderRequests.length).toBeGreaterThanOrEqual(2);
    expect(String(olderRequests.at(-1)?.[0])).toContain("before=message-11");

    await act(async () => {
      for (const pending of pendings) {
        pending.resolve(
          jsonResponse({
            thread,
            messages: makeMessages(10),
            artifacts: [],
            runs: [run],
            toolCalls: [],
            activeRuns: [run],
            page: {
              totalMessages: 60,
              totalArtifacts: 0,
              firstMessageIndex: 1,
              lastMessageIndex: 10,
              beforeCursor: null,
              afterCursor: "message-10",
            },
          }),
        );
      }
    });
    expect(await screen.findByText("Messages 1–10 of 60")).toBeInTheDocument();
    expect(screen.queryByText("Message 60")).not.toBeInTheDocument();
    expect(screen.queryByText("History exploded.")).not.toBeInTheDocument();
  });

  it("settles loading after a quiet poll failure so paging stays usable", async () => {
    const user = userEvent.setup();
    const timers = installIntervalTimers();
    const run: AgentRun = {
      id: "run-quiet",
      threadId: thread.id,
      triggerMessageId: "message-2",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    let failQuiet = false;
    const historyOverrides = {
      [thread.id]: (_path: string) => {
        if (failQuiet) return jsonResponse({ error: { message: "Quiet failure." } }, 500);
        return null;
      },
    };
    mockServer({
      runs: [run],
      activeRuns: [run],
      historyOverrides,
    });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Message 60");
    failQuiet = true;
    await timers.tick();
    await waitFor(() =>
      expect(document.querySelector(".thread-history-bar .spin")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Older messages/ })).toBeEnabled();

    failQuiet = false;
    await user.click(screen.getByRole("button", { name: /Older messages/ }));
    expect(await screen.findByText("Message 1")).toBeVisible();
  });

  it("only focuses an explicitly navigated older page, not a quiet reload", async () => {
    const timers = installIntervalTimers();
    const run: AgentRun = {
      id: "run-focus",
      threadId: thread.id,
      triggerMessageId: "message-2",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    const user = userEvent.setup();
    mockServer({ runs: [run], activeRuns: [run] });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Message 60");
    const beforeOlder = scrollIntoView.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /Older messages/ }));
    await screen.findByText("Message 1");
    expect(scrollIntoView.mock.calls.length).toBeGreaterThan(beforeOlder);

    const afterExplicit = scrollIntoView.mock.calls.length;
    await timers.tick();
    await act(async () => {});
    expect(scrollIntoView.mock.calls.length).toBe(afterExplicit);
  });

  it("ignores a delayed old-workspace history reply after switching workspaces", async () => {
    const user = userEvent.setup();
    const pending = deferredResponse();
    const historyOverrides = {
      [thread.id]: () => pending.promise,
    };
    const { fetchMock } = mockServer({ historyOverrides });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/history"),
        expect.anything(),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Switch to Other" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await screen.findByRole("heading", { name: "# Other" })).toBeVisible();
    expect(screen.getByText("Message 60")).toBeVisible();

    await act(async () => {
      pending.resolve(
        jsonResponse(
          historyPageFor(
            {
              thread,
              messages: [makeMessage("message-stale", 1, "Stale reply")],
              artifacts: [],
              runs: [],
              toolCalls: [],
            },
            new URLSearchParams({ workspaceId: workspace.id, limit: "50" }),
          ),
        ),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale reply")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "# Other" })).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/threads/thread-history/history"),
      ),
    ).toHaveLength(1);
  });

  it("opens an attention run whose trigger lies outside the latest window", async () => {
    const user = userEvent.setup();
    const run: AgentRun = {
      id: "run-outside",
      threadId: thread.id,
      triggerMessageId: "message-2",
      agentId: workerAgent.id,
      attempt: 1,
      status: "waiting_input",
      createdAt: now,
      updatedAt: now,
    };
    const attentionItem = runAttentionItem(run, workerAgent.name, thread.name);
    mockServer({
      runs: [run],
      activeRuns: [run],
      attention: attentionItem ? [attentionItem] : [],
    });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Message 60");
    expect(screen.queryByText("Message 2")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: /Needs attention/ }));
    await user.click(
      screen.getByRole("button", { name: `Open run: ${workerAgent.name} in #${thread.name}` }),
    );
    const selected = await screen.findByRole("region", { name: "Selected message" });
    expect(within(selected).getByText("Message 2")).toBeVisible();
    expect(window.location.search).toBe("?message=message-2");
    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveTextContent("1");
  });

  it("lazily loads files & links only when the tab is opened and caches the full reply", async () => {
    const user = userEvent.setup();
    const artifacts: Artifact[] = [
      {
        id: "artifact-plan",
        threadId: thread.id,
        messageId: "message-3",
        sequence: 3,
        kind: "file",
        source: "upload",
        name: "plan.md",
        mediaType: "text/markdown",
        size: 7,
        createdAt: now,
      },
    ];
    const agentMessages = allMessages.map((message, index) =>
      index === 2
        ? {
            ...message,
            author: {
              kind: "agent" as const,
              id: workerAgent.id,
              name: workerAgent.name,
              handle: workerAgent.handle,
            },
          }
        : message,
    );
    const { fetchMock } = mockServer({ messages: agentMessages, artifacts });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Message 60");
    expect(screen.getByRole("button", { name: /Files & links/ })).toHaveTextContent("1");
    const fullGetCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input) === `/api/threads/${thread.id}`);
    expect(fullGetCalls()).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: /Files & links/ }));
    expect(await screen.findByText("plan.md")).toBeVisible();
    expect(screen.getByText(/Shared by Planner/)).toBeVisible();
    expect(fullGetCalls()).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Messages" }));
    expect(screen.getByText("Message 60")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Files & links/ }));
    expect(screen.getByText("plan.md")).toBeVisible();
    expect(fullGetCalls()).toHaveLength(1);
  });

  it("labels messages by their actual local day instead of hardcoding Today", async () => {
    const messages = [
      makeMessage("message-old", 1, "Old note", dayAt(1)),
      makeMessage("message-today", 2, "Today note", dayAt(0)),
    ];
    mockServer({ messages });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    expect(await screen.findByText("Today note")).toBeVisible();
    expect(screen.getByText("Old note")).toBeVisible();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
  });

  it("loads the latest page after a successful send and clears the message target", async () => {
    const user = userEvent.setup();
    mockServer();
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-5`);
    render(<App />);

    await screen.findByRole("region", { name: "Selected message" });
    const composer = screen.getByRole("combobox", { name: "Message" });
    await user.type(composer, "New latest note");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("New latest note")).toBeVisible();
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("region", { name: "Selected message" })).not.toBeInTheDocument();
  });

  it("keeps a linked message centered while lazy markdown changes its height", async () => {
    const timers = installIntervalTimers();
    const run: AgentRun = {
      id: "run-center",
      threadId: thread.id,
      triggerMessageId: "message-2",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    mockServer({ runs: [run], activeRuns: [run] });
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-5`);
    let queuedFrames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    const flushFrames = () =>
      act(async () => {
        const pending = queuedFrames;
        queuedFrames = [];
        for (const callback of pending) callback();
      });
    const rect = (top: number, height: number) =>
      ({
        top,
        left: 0,
        bottom: top + height,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rects = new WeakMap<HTMLElement, { top: number; height: number }>();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const entry = rects.get(this);
      if (!entry) return rect(0, 0);
      const container = document.querySelector(".message-scroll") as HTMLElement | null;
      const scrolled =
        container && container !== this && container.contains(this) ? container.scrollTop : 0;
      return rect(entry.top - scrolled, entry.height);
    });
    render(<App />);
    await screen.findByRole("region", { name: "Selected message" });

    const container = document.querySelector(".message-scroll") as HTMLElement;
    const target = document.querySelector(".message-target") as HTMLElement;
    expect(container).toBeTruthy();
    expect(target).toBeTruthy();
    rects.set(container, rect(0, 400));
    rects.set(target, rect(150, 300));
    await flushFrames();
    expect(container.scrollTop).toBe(100);

    // The lazy RichMessage can replace the fallback with taller markdown after the
    // initial centering; the watcher must re-center while that layout settles.
    rects.set(target, rect(480, 600));
    await flushFrames();
    expect(container.scrollTop).toBe(580);

    // A user scroll during the watcher stops any further correction.
    container.scrollTop = 900;
    container.dispatchEvent(new Event("wheel", { bubbles: true }));
    await flushFrames();
    expect(container.scrollTop).toBe(900);

    // Later layout changes and quiet refreshes must not yank the view anymore.
    rects.set(target, rect(100, 120));
    await flushFrames();
    expect(container.scrollTop).toBe(900);
    await timers.tick();
    await flushFrames();
    expect(container.scrollTop).toBe(900);
    expect(screen.getByRole("heading", { name: "# History" })).toBeVisible();
  });

  it("keeps centering a linked message under StrictMode while markdown loads async", async () => {
    const run: AgentRun = {
      id: "run-strict-mode",
      threadId: thread.id,
      triggerMessageId: "message-2",
      agentId: workerAgent.id,
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    mockServer({ runs: [run], activeRuns: [run] });
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-5`);
    let queuedFrames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    const flushFrames = () =>
      act(async () => {
        const pending = queuedFrames;
        queuedFrames = [];
        for (const callback of pending) callback();
      });
    const rect = (top: number, height: number) =>
      ({
        top,
        left: 0,
        bottom: top + height,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const rects = new WeakMap<HTMLElement, { top: number; height: number }>();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const entry = rects.get(this);
      if (!entry) return rect(0, 0);
      const container = document.querySelector(".message-scroll") as HTMLElement | null;
      const scrolled =
        container && container !== this && container.contains(this) ? container.scrollTop : 0;
      return rect(entry.top - scrolled, entry.height);
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole("region", { name: "Selected message" });

    const container = document.querySelector(".message-scroll") as HTMLElement;
    const target = document.querySelector(".message-target") as HTMLElement;
    rects.set(container, rect(0, 400));
    rects.set(target, rect(150, 300));
    await flushFrames();
    await flushFrames();
    expect(container.scrollTop).toBe(100);

    // StrictMode must not leave the watcher dead: a later height change still
    // re-centers the linked message once its markdown has rendered.
    rects.set(target, rect(480, 600));
    await flushFrames();
    expect(container.scrollTop).toBe(580);
  });
});
