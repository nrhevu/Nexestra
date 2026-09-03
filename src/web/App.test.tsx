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
          artifactIds: [],
          createdAt: now,
        },
      ],
      artifacts: [],
      runs: [run],
      toolCalls: [],
    };
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
        if (String(input) === `/api/threads/${thread.id}`) return jsonResponse(transcript);
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
    expect(screen.getByText("Writing a response")).toBeInTheDocument();
    expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
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
