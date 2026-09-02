// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.unstubAllGlobals();
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
          triggerMessageId: "message-trigger",
          createdAt: now,
        },
      ],
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
    const emptyTranscript: ThreadData = { thread, messages: [], runs: [] };
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
