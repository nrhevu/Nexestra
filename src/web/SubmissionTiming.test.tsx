// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData, Thread, ThreadData, ThreadHistoryPage } from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-02T12:00:00.000Z";

const workspace = {
  id: "workspace-nexestra",
  name: "Nexestra",
  slug: "nexestra",
  createdAt: now,
  updatedAt: now,
};

function threadRow(id: string, name: string): Thread {
  return {
    id,
    name,
    slug: name,
    workspaceId: workspace.id,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessageAt: null,
    archived: false,
  };
}

function historyUrl(thread: Thread): string {
  return (
    "/api/threads/" +
    encodeURIComponent(thread.id) +
    "/history?workspaceId=" +
    encodeURIComponent(thread.workspaceId) +
    "&limit=50"
  );
}

function historySnapshot(thread: Thread): ThreadHistoryPage {
  const data: ThreadData = { thread, runs: [], messages: [], artifacts: [], toolCalls: [] };
  return {
    ...data,
    activeRuns: [],
    page: {
      totalMessages: 0,
      totalArtifacts: 0,
      firstMessageIndex: 0,
      lastMessageIndex: 0,
      beforeCursor: null,
      afterCursor: null,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pendingKey(workspaceId: string, threadId: string): string {
  return `nexestra.pendingSubmission.1.${workspaceId}:${threadId}`;
}

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

describe("Submission timing", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps Files & links open when an in-flight send completes", async () => {
    const thread = threadRow("send-files-tab", "general");
    let finishSend!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap"))
        return jsonResponse({ ...bootstrapData, threads: [thread] });
      if (path === historyUrl(thread) || path === `/api/threads/${thread.id}`)
        return jsonResponse(historySnapshot(thread));
      if (path.endsWith("/messages") && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          finishSend = resolve;
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "Send while browsing",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(finishSend).toBeTypeOf("function"));
    await user.click(screen.getByRole("button", { name: "Files & links" }));
    await screen.findByText("No files or links yet");
    await act(async () => {
      finishSend(jsonResponse({ message: {}, runs: [] }, 201));
    });
    await waitFor(() =>
      expect(window.localStorage.getItem(pendingKey(workspace.id, thread.id))).toBeNull(),
    );
    expect(screen.getByText("No files or links yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files & links" })).toHaveClass("active");
  });

  it("retires sent files in the originating workspace after navigating and keeps the new workspace draft", async () => {
    const first = threadRow("send-origin", "First");
    const otherWorkspace = { ...workspace, id: "send-other-workspace", name: "Other" };
    const second = { ...threadRow("send-destination", "Second"), workspaceId: otherWorkspace.id };
    let finishSend!: (response: Response) => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        const other = path.includes(otherWorkspace.id);
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, otherWorkspace],
          workspace: other ? otherWorkspace : workspace,
          threads: [other ? second : first],
        });
      }
      const target = [first, second].find((thread) => path === historyUrl(thread));
      if (target) return jsonResponse(historySnapshot(target));
      if (path === `/api/threads/${first.id}/messages` && init?.method === "POST") {
        return new Promise<Response>((resolve) => {
          finishSend = resolve;
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/threads/${first.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("combobox", { name: "Message" }), "Original draft");
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["original"], "original.txt"),
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(finishSend).toBeTypeOf("function"));
    await user.click(screen.getByRole("button", { name: "Switch to Other" }));
    await screen.findByRole("heading", { name: "# Second" });
    await user.type(screen.getByRole("combobox", { name: "Message" }), "New workspace draft");
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["new"], "new.txt"),
    );
    const requests = fetchMock.mock.calls.length;
    await act(async () => {
      finishSend(jsonResponse({ message: {}, runs: [] }, 201));
    });
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("New workspace draft");
    expect(screen.getByText("new.txt")).toBeInTheDocument();
    expect(window.localStorage.getItem(pendingKey(workspace.id, first.id))).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    await user.click(screen.getByRole("button", { name: "Switch to Nexestra" }));
    await screen.findByRole("heading", { name: "# First" });
    expect(screen.getByRole("combobox", { name: "Message" })).toHaveValue("");
    expect(screen.queryByText("original.txt")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to Other" }));
    await screen.findByRole("heading", { name: "# Second" });
    expect(screen.getByText("new.txt")).toBeInTheDocument();
  });

  it("keeps files reused by a newer unconfirmed send when an older send completes", async () => {
    const thread = threadRow("send-reused-files", "general");
    const posts: FormData[] = [];
    const replies: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.startsWith("/api/bootstrap"))
          return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path.endsWith("/messages") && init?.method === "POST") {
          posts.push(init.body as FormData);
          if (posts.length === 3) return jsonResponse({ message: {}, runs: [] }, 201);
          return new Promise<Response>((resolve) => {
            replies.push(resolve);
          });
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    window.history.replaceState({}, "", `/threads/${thread.id}`);
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByRole("combobox", { name: "Message" }), "Old payload");
    await user.upload(
      screen.getByLabelText("Choose files or images"),
      new File(["shared bytes"], "retained.txt"),
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Surfaces" }));
    await user.click(screen.getByRole("button", { name: "Threads" }));
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.clear(composer);
    await user.type(composer, "New payload with the same file");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0]?.get("requestId")).not.toBe(posts[1]?.get("requestId"));
    await act(async () => {
      replies[0]?.(jsonResponse({ message: {}, runs: [] }, 201));
    });
    expect(composer).toHaveValue("New payload with the same file");
    expect(screen.getByText("retained.txt")).toBeInTheDocument();
    await act(async () => {
      replies[1]?.(jsonResponse({ error: { message: "Second send unconfirmed" } }, 503));
    });
    await screen.findByText("Second send unconfirmed");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]?.get("requestId")).toBe(posts[1]?.get("requestId"));
    expect(posts[2]?.get("files")).toMatchObject({ name: "retained.txt" });
    await waitFor(() => expect(screen.queryByText("retained.txt")).not.toBeInTheDocument());
    expect(composer).toHaveValue("");
  });

  it("posts the text captured at Send and keeps a newer edited draft", async () => {
    const user = userEvent.setup();
    const thread = threadRow("thread-timing-edit", "general");
    const posts: Record<string, unknown>[] = [];
    window.history.replaceState({}, "", `/threads/${thread.id}`);

    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const gates: { promise: Promise<void>; resolve: () => void }[] = [];
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((finish) => {
        release = finish;
      });
      gates.push({ promise: gate, resolve: release });
      return gate.then(() => originalDigest(algorithm, data));
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") return jsonResponse({ ...bootstrapData, threads: [thread] });
        if (path === historyUrl(thread)) return jsonResponse(historySnapshot(thread));
        if (path === `/api/threads/${thread.id}/messages` && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );

    render(<App />);
    const composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "original text");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(gates).toHaveLength(1));
    await user.type(composer, " newer draft");

    await act(async () => {
      gates[0]?.resolve();
    });
    await waitFor(() => expect(posts).toHaveLength(1));

    expect(posts[0]).toMatchObject({ content: "original text" });
    expect(posts[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(composer).toHaveValue("original text newer draft");
    expect(window.localStorage.getItem(`nexestra.draft.${workspace.id}:${thread.id}`)).toBe(
      "original text newer draft",
    );
    expect(window.localStorage.getItem(pendingKey(workspace.id, thread.id))).toBeNull();
  });

  it("lets the newest send win and rejects an older preparation after a view remount", async () => {
    const user = userEvent.setup();
    const first = threadRow("thread-timing-first", "first");
    const second = threadRow("thread-timing-second", "second");
    const posts: Record<string, unknown>[] = [];
    window.history.replaceState({}, "", `/threads/${first.id}`);

    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const gates: { promise: Promise<void>; resolve: () => void }[] = [];
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((finish) => {
        release = finish;
      });
      gates.push({ promise: gate, resolve: release });
      return gate.then(() => originalDigest(algorithm, data));
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path === "/api/bootstrap") {
          return jsonResponse({ ...bootstrapData, threads: [first, second] });
        }
        if (path === historyUrl(first)) return jsonResponse(historySnapshot(first));
        if (path === historyUrl(second)) return jsonResponse(historySnapshot(second));
        if (path === `/api/threads/${first.id}/messages` && init?.method === "POST") {
          posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return jsonResponse({ message: {}, runs: [] }, 201);
        }
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );

    render(<App />);
    let composer = await screen.findByRole("combobox", { name: "Message" });
    await user.type(composer, "first text");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(gates).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: /#second/ }));
    await user.click(screen.getByRole("button", { name: /#first/ }));
    composer = await screen.findByRole("combobox", { name: "Message" });
    await user.clear(composer);
    await user.type(composer, "second text");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(gates).toHaveLength(2));

    await act(async () => {
      gates[1]?.resolve();
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ content: "second text" });

    await act(async () => {
      gates[0]?.resolve();
    });
    await waitFor(() => expect(gates).toHaveLength(2));
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toMatchObject({ content: "first text" });
    expect(composer).toHaveValue("");
    expect(window.localStorage.getItem(pendingKey(workspace.id, first.id))).toBeNull();
  });
});
