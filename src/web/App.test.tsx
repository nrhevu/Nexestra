// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentView, BootstrapData, ThreadData } from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-02T12:00:00.000Z";
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
      if (path === `/api/threads/${thread.id}`) {
        threadReads += 1;
        return jsonResponse({
          thread,
          messages: [],
          artifacts: [],
          runs: [{ ...run, status: threadReads === 1 ? "running" : "completed" }],
          toolCalls: [],
        });
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
        if (String(input) === `/api/threads/${thread.id}`) return jsonResponse(currentTranscript);
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

describe("Workspace navigation", () => {
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

describe("Thread navigation", () => {
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
    };
    const secondThread = {
      ...firstThread,
      id: "thread-second",
      name: "Second thread",
      slug: "second-thread",
    };
    const transcript = (thread: typeof firstThread, content: string): ThreadData => ({
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
      if (path === `/api/threads/${firstThread.id}`) {
        firstReads += 1;
        return firstReads === 1
          ? jsonResponse(transcript(firstThread, "First transcript"))
          : olderReload;
      }
      if (path === `/api/threads/${secondThread.id}`) return secondLoad;
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
        if (path === `/api/threads/${thread.id}`) {
          return jsonResponse({ thread, messages: [], artifacts: [], runs: [], toolCalls: [] });
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
    };
    const task = {
      id: "task-build",
      workspaceId: workspace.id,
      title: "Build the repository feature",
      description: "Implement and test the requested change.",
      status: "in_progress" as const,
      assigneeId: workerAgent.id,
      threadId: thread.id,
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
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: `Open process for ${task.title}` }));

    const dialog = await screen.findByRole("dialog", { name: task.title });
    expect(within(dialog).getByText("@planner")).toBeVisible();
    expect(within(dialog).getByText("#product-repo")).toBeVisible();
    expect(within(dialog).getByText("Using read")).toBeVisible();
    expect(within(dialog).getByText("read")).toBeVisible();
    expect(within(dialog).getByText("Implementing the change…")).toBeVisible();
    await user.click(within(dialog).getByText("Thinking"));
    expect(await within(dialog).findByText("Inspecting")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Stop process" }));
    expect(await within(dialog).findByText("Worker process stopped")).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === `/api/tasks/${task.id}/stop` && init?.method === "POST",
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
      if (path === `/api/threads/${thread.id}`) return jsonResponse(transcript);
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
        if (path === `/api/threads/${thread.id}`) return jsonResponse(transcript);
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
      if (path === `/api/threads/${thread.id}` && !init?.method) {
        return jsonResponse(emptyTranscript);
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
        if (path === `/api/threads/${thread.id}`) return jsonResponse(transcript);
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
      if (path === `/api/threads/${thread.id}` && !init?.method) {
        return jsonResponse(transcript);
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
        if (path === `/api/threads/${thread.id}`) return jsonResponse(transcript);
        return jsonResponse({ error: { message: "Not found" } }, 404);
      }),
    );
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /Files & links/ }));
    expect(screen.getByAltText("diagram.png")).toBeInTheDocument();
    expect(screen.getByText("brief.md")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/spec")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Links" }));
    expect(screen.queryByText("brief.md")).not.toBeInTheDocument();
    expect(screen.getByText("https://example.com/spec")).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
