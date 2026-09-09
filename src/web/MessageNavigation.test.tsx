// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BootstrapData,
  Message,
  Thread,
  ThreadData,
  ThreadHistoryPage,
} from "../shared/contracts.js";
import { THREAD_HISTORY_DEFAULT_LIMIT } from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-09T00:00:00.000Z";
const workspace = {
  id: "workspace-notes",
  name: "Notes",
  slug: "notes",
  createdAt: now,
  updatedAt: now,
};
const otherWorkspace = { ...workspace, id: "workspace-client", name: "Client", slug: "client" };
const thread: Thread = {
  id: "thread-release",
  workspaceId: workspace.id,
  name: "Release",
  slug: "release",
  archived: false,
  createdAt: now,
  updatedAt: now,
  messageCount: 3,
  lastMessageAt: now,
};
const otherThread: Thread = { ...thread, id: "thread-client", workspaceId: otherWorkspace.id };
const messages: Message[] = ["Opening note", "Ship on Friday", "Latest note"].map(
  (content, index) => ({
    id: `message-${index}`,
    threadId: thread.id,
    sequence: index + 1,
    author: { kind: "user", id: "local-user", name: "You" },
    content,
    mentions: [],
    knowledgeReferences: [],
    artifactIds: [],
    createdAt: now,
  }),
);
const bootstrap: BootstrapData = {
  workspaces: [workspace, otherWorkspace],
  workspace,
  agents: [],
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

function mockWorkspace(selectedThread = thread, searchMessage?: Message) {
  const threadsById = new Map([
    [thread.id, thread],
    [otherThread.id, otherThread],
    [selectedThread.id, selectedThread],
  ]);
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/search/messages?")) {
        const params = new URL(path, "http://localhost").searchParams;
        return Response.json({
          query: {
            term: params.get("q"),
            workspaceId: params.get("workspaceId"),
            threadId: null,
            archived: "all",
          },
          matches: searchMessage
            ? [
                {
                  messageId: searchMessage.id,
                  sequence: searchMessage.sequence,
                  thread: selectedThread,
                  author: searchMessage.author,
                  createdAt: searchMessage.createdAt,
                  snippet: searchMessage.content,
                },
              ]
            : [],
          matchesFound: searchMessage ? 1 : 0,
          complete: true,
          nextOffset: null,
          diagnostics: {},
        });
      }
      const selectedWorkspace =
        selectedThread.workspaceId === workspace.id ? workspace : otherWorkspace;
      if (path.startsWith("/api/bootstrap")) {
        const requested = new URL(path, "http://localhost").searchParams.get("workspaceId");
        const foreign = requested === otherWorkspace.id;
        return Response.json({
          ...bootstrap,
          workspace: foreign ? otherWorkspace : workspace,
          threads:
            requested === selectedWorkspace.id || (!requested && selectedWorkspace === workspace)
              ? [selectedThread]
              : [foreign ? otherThread : thread],
        });
      }
      const notFound = () => Response.json({ error: { message: "Not found" } }, { status: 404 });
      const historyMatch = path.match(/^\/api\/threads\/([^/]+)\/history(?=$|[?/])/);
      if (historyMatch) {
        const requestedThread = threadsById.get(decodeURIComponent(historyMatch[1] ?? ""));
        if (!requestedThread) return notFound();
        const snapshot: ThreadData = {
          thread: requestedThread,
          messages: messages.map((message) => ({ ...message, threadId: requestedThread.id })),
          artifacts: [],
          runs: [],
          toolCalls: [],
        };
        return Response.json(
          historyPageFor(snapshot, new URL(path, "http://localhost").searchParams),
        );
      }
      const metadataMatch = path.match(/^\/api\/threads\/([^/]+)\/metadata/);
      if (metadataMatch) {
        const requestedThread = threadsById.get(decodeURIComponent(metadataMatch[1] ?? ""));
        return requestedThread ? Response.json(requestedThread) : notFound();
      }
      const fullMatch = path.match(/^\/api\/threads\/([^/]+)$/);
      if (fullMatch) {
        const requestedThread = threadsById.get(decodeURIComponent(fullMatch[1] ?? ""));
        if (!requestedThread) return notFound();
        const snapshot: ThreadData = {
          thread: requestedThread,
          messages: messages.map((message) => ({ ...message, threadId: requestedThread.id })),
          artifacts: [],
          runs: [],
          toolCalls: [],
        };
        return Response.json(snapshot);
      }
      return notFound();
    }),
  );
}

function followLocation(path: string) {
  act(() => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("Message navigation", () => {
  it("opens an archived search hit and can select that same message again from Files & links", async () => {
    const user = userEvent.setup();
    mockWorkspace({ ...thread, archived: true }, messages[1]);
    window.history.replaceState({}, "", "/surfaces/agents");
    render(<App />);
    const search = await screen.findByRole("combobox", {
      name: "Search threads, tasks, agents, or knowledge",
    });
    await user.type(search, "Ship on Friday");
    await user.click(screen.getByRole("button", { name: "Search messages" }));
    const dialog = await screen.findByRole("dialog", { name: "Search messages" });
    await user.click(await within(dialog).findByRole("button", { name: /Ship on Friday/ }));

    let selected = await screen.findByRole("region", { name: "Selected message" });
    expect(selected).toHaveFocus();
    expect(window.location.pathname).toBe(`/threads/${thread.id}`);
    expect(window.location.search).toBe("?message=message-1");
    expect(screen.queryByRole("combobox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Search messages" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Files & links" }));
    await user.click(screen.getByRole("button", { name: "Search messages" }));
    const nextDialog = screen.getByRole("dialog", { name: "Search messages" });
    await user.type(within(nextDialog).getByRole("searchbox"), "Ship on Friday");
    await user.click(within(nextDialog).getByRole("button", { name: "Search" }));
    await user.click(await within(nextDialog).findByRole("button", { name: /Ship on Friday/ }));

    selected = await screen.findByRole("region", { name: "Selected message" });
    expect(selected).toHaveFocus();
    expect(within(selected).getByText("Ship on Friday")).toBeVisible();
    expect(screen.getByRole("button", { name: "Messages" })).toHaveClass("active");
  });

  it.each([false, true])(
    "opens the selected message from a durable link (archived=%s)",
    async (archived) => {
      mockWorkspace({ ...thread, archived });
      window.history.replaceState({}, "", `/threads/${thread.id}?message=message-1`);
      render(<App />);

      const selected = await screen.findByRole("region", { name: "Selected message" });
      expect(within(selected).getByText("Ship on Friday")).toBeVisible();
      expect(selected).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "center" });
      expect(window.location.search).toBe("?message=message-1");
      if (archived) {
        expect(screen.queryByRole("combobox", { name: "Message" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Restore" })).toBeVisible();
      }
    },
  );

  it("shows latest messages on request and can return to a message in the same thread", async () => {
    const user = userEvent.setup();
    mockWorkspace();
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-1`);
    render(<App />);
    await screen.findByRole("region", { name: "Selected message" });
    await user.click(screen.getAllByRole("button", { name: "Show latest" })[0] as Element);

    expect(window.location.search).toBe("");
    expect(screen.queryByRole("region", { name: "Selected message" })).not.toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "end" });

    await user.click(screen.getByRole("button", { name: "Files & links" }));
    followLocation(`/threads/${thread.id}?message=message-0`);
    const selected = await screen.findByRole("region", { name: "Selected message" });
    expect(within(selected).getByText("Opening note")).toBeVisible();
    await waitFor(() => expect(selected).toHaveFocus());
    expect(screen.getByRole("button", { name: "Messages" })).toHaveClass("active");
  });

  it("reports an unavailable message without highlighting a different message", async () => {
    const user = userEvent.setup();
    mockWorkspace();
    window.history.replaceState({}, "", `/threads/${thread.id}?message=missing`);
    render(<App />);

    await screen.findByText("The linked message is not available in this thread.");
    expect(screen.queryByRole("region", { name: "Selected message" })).not.toBeInTheDocument();
    expect(screen.getByText("Latest note")).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: "Show latest" })[0] as Element);
    expect(window.location.search).toBe("");
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "end" });
  });

  it("retains a message target while resolving a foreign archived thread", async () => {
    mockWorkspace({ ...otherThread, archived: true });
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", `/threads/${otherThread.id}?message=message-1`);
    render(<App />);

    const selected = await screen.findByRole("region", { name: "Selected message" });
    expect(within(selected).getByText("Ship on Friday")).toBeVisible();
    expect(window.location.search).toBe("?message=message-1");
    expect(screen.getByRole("button", { name: "Switch to Client" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("clears the previous workspace's message target on an ordinary workspace switch", async () => {
    const user = userEvent.setup();
    mockWorkspace(otherThread);
    window.history.replaceState({}, "", `/threads/${thread.id}?message=message-1`);
    render(<App />);
    await screen.findByRole("region", { name: "Selected message" });
    await user.click(screen.getByRole("button", { name: "Switch to Client" }));

    await waitFor(() => expect(window.location.pathname).toBe(`/threads/${otherThread.id}`));
    expect(window.location.search).toBe("");
    expect(screen.queryByRole("region", { name: "Selected message" })).not.toBeInTheDocument();
  });

  it("reopens a copied message link for a renamed archived thread through around history", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mockWorkspace({ ...thread, name: "Release after rename", archived: true });
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    render(<App />);

    await screen.findByText("Ship on Friday");
    const messageArticle = screen.getByText("Ship on Friday").closest("article");
    expect(messageArticle).not.toBeNull();
    await user.click(
      within(messageArticle as HTMLElement).getByRole("button", { name: "Copy message link" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copiedUrl = writeText.mock.calls[0]?.[0] as string;
    expect(copiedUrl).toBe(`${window.location.origin}/threads/${thread.id}?message=message-1`);

    followLocation(copiedUrl.replace(/^https?:\/\/[^/]+/, ""));
    const selected = await screen.findByRole("region", { name: "Selected message" });
    await waitFor(() => expect(selected).toHaveFocus());
    expect(within(selected).getByText("Ship on Friday")).toBeVisible();
    expect(window.location.search).toBe("?message=message-1");
    expect(screen.getByRole("button", { name: "Restore" })).toBeVisible();

    if (clipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
