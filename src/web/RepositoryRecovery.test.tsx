// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentView, BootstrapData } from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-02T12:00:00.000Z";
const later = "2026-09-02T13:00:00.000Z";

const workspace = {
  id: "workspace-nexestra",
  name: "Nexestra",
  slug: "nexestra",
  createdAt: now,
  updatedAt: now,
};

const productWorkspace = {
  id: "workspace-product",
  name: "Product",
  slug: "product",
  createdAt: now,
  updatedAt: now,
};

const workerAgent: AgentView = {
  id: "agent-recovery",
  workspaceId: workspace.id,
  kind: "worker",
  name: "Recovery worker",
  handle: "recovery-worker",
  description: "Runs recovery tasks",
  instructions: "",
  enabled: true,
  archived: false,
  harness: "codex",
  createdAt: now,
  updatedAt: now,
  readiness: "ready",
  readinessLabel: "Ready",
};

const thread = {
  id: "thread-recovery",
  workspaceId: workspace.id,
  name: "general",
  slug: "general",
  createdAt: now,
  updatedAt: now,
  messageCount: 1,
  lastMessageAt: now,
};

const task = {
  id: "task-recovery",
  workspaceId: workspace.id,
  title: "Build the recovery feature",
  description: "",
  status: "todo" as const,
  assigneeId: null,
  threadId: thread.id,
  verificationCommand: "pnpm test",
  createdAt: now,
  updatedAt: now,
};

const failedRepository = {
  id: "repository-recovery",
  workspaceId: workspace.id,
  kind: "repository" as const,
  name: "Recovery repository",
  handle: "recovery",
  description: "",
  source: "https://github.com/example/recovery.git",
  storagePath: "workspaces/workspace-nexestra/repositories/repository-recovery/source",
  status: "failed" as const,
  error: "The source was temporarily unavailable.",
  createdAt: now,
  updatedAt: now,
};

const readyRepository = {
  ...failedRepository,
  status: "ready" as const,
  defaultBranch: "main",
  error: undefined,
  updatedAt: later,
};

const productRepository = {
  id: "repository-product",
  workspaceId: productWorkspace.id,
  kind: "repository" as const,
  name: "Product repository",
  handle: "product",
  description: "",
  source: "https://github.com/example/product.git",
  storagePath: "workspaces/workspace-product/repositories/repository-product/source",
  status: "ready" as const,
  defaultBranch: "main",
  createdAt: now,
  updatedAt: now,
};

const bootstrapData: BootstrapData = {
  workspaces: [workspace, productWorkspace],
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe("Repository recovery", () => {
  it("updates the knowledge card and ready-repository choice after a successful retry", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let bootstraps = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          agents: [workerAgent],
          threads: [thread],
          tasks: [task],
          knowledge: [failedRepository],
        });
      }
      if (
        path === "/api/knowledge/repositories/repository-recovery/retry" &&
        init?.method === "POST"
      ) {
        return jsonResponse(readyRepository);
      }
      if (path === "/api/tasks/task-recovery/process") {
        return jsonResponse({ task, assignments: [], toolCalls: [] });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    const detailsButton = screen.getByRole("button", {
      name: `View details for ${failedRepository.name}`,
    });
    const card = detailsButton.closest("article");
    if (!card) throw new Error("expected repository knowledge card");
    expect(within(card).getByText("failed")).toBeVisible();

    await user.click(detailsButton);
    const details = screen.getByRole("dialog", { name: failedRepository.name });
    expect(within(details).getByText("The source was temporarily unavailable.")).toBeVisible();
    await user.click(within(details).getByRole("button", { name: "Retry clone" }));

    expect(await within(details).findByText("ready")).toBeVisible();
    expect(within(details).getByRole("button", { name: "Done" })).toBeVisible();
    expect(within(details).queryByRole("button", { name: "Retry clone" })).not.toBeInTheDocument();
    await user.click(within(details).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: failedRepository.name })).not.toBeInTheDocument();
    expect(within(card).getByText("ready")).toBeVisible();
    expect(bootstraps).toBe(1);

    await user.click(screen.getByRole("button", { name: /Taskboard/ }));
    await user.click(screen.getByRole("button", { name: `Open process for ${task.title}` }));
    const process = await screen.findByRole("dialog", { name: task.title });
    const repositorySelect = await within(process).findByRole("combobox", { name: "Repository" });
    expect(repositorySelect).toHaveValue(failedRepository.id);
    expect(within(process).getByRole("option", { name: "#recovery" })).toBeInTheDocument();
    expect(bootstraps).toBe(1);
  });

  it("keeps a failed retry visible and retryable on the card and in the dialog", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({
          ...bootstrapData,
          knowledge: [failedRepository],
        });
      }
      if (
        path === "/api/knowledge/repositories/repository-recovery/retry" &&
        init?.method === "POST"
      ) {
        return jsonResponse({
          ...failedRepository,
          error: "Still offline.",
          updatedAt: later,
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    const detailsButton = screen.getByRole("button", {
      name: `View details for ${failedRepository.name}`,
    });
    await user.click(detailsButton);
    const details = screen.getByRole("dialog", { name: failedRepository.name });
    await user.click(within(details).getByRole("button", { name: "Retry clone" }));

    expect(await within(details).findByText("Still offline.")).toBeVisible();
    const retryButton = within(details).getByRole("button", { name: "Retry clone" });
    await waitFor(() => expect(retryButton).toBeEnabled());
    expect(within(details).getByText("failed")).toBeVisible();
    expect(screen.queryByRole("status", { name: /Repository/i })).not.toBeInTheDocument();

    await user.click(within(details).getByRole("button", { name: "Done" }));
    const card = screen
      .getByRole("button", {
        name: `View details for ${failedRepository.name}`,
      })
      .closest("article");
    if (!card) throw new Error("expected repository knowledge card");
    expect(within(card).getByText("failed")).toBeVisible();
    expect(screen.getByRole("button", { name: /Taskboard/ })).toBeVisible();
  });

  it("does not reopen a closed dialog when a delayed retry resolves", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let bootstraps = 0;
    const pendingRetry = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          knowledge: [failedRepository],
        });
      }
      if (
        path === "/api/knowledge/repositories/repository-recovery/retry" &&
        init?.method === "POST"
      ) {
        return pendingRetry.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${failedRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: failedRepository.name });
    const retryButton = within(details).getByRole("button", { name: "Retry clone" });
    await user.click(retryButton);
    expect(await within(details).findByRole("button", { name: "Retrying…" })).toBeDisabled();

    await user.click(within(details).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: failedRepository.name })).not.toBeInTheDocument();

    await act(async () => {
      pendingRetry.resolve(jsonResponse(readyRepository));
    });
    await act(async () => {});

    expect(screen.queryByRole("dialog", { name: failedRepository.name })).not.toBeInTheDocument();
    const card = screen
      .getByRole("button", {
        name: `View details for ${failedRepository.name}`,
      })
      .closest("article");
    if (!card) throw new Error("expected repository knowledge card");
    await waitFor(() => expect(within(card).getByText("ready")).toBeVisible());
    expect(bootstraps).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge/repositories/repository-recovery/retry",
      { method: "POST", headers: {} },
    );
  });

  it("ignores a delayed retry after switching workspaces", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const pendingRetry = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          knowledge: [failedRepository],
        });
      }
      if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          workspace: productWorkspace,
          knowledge: [productRepository],
        });
      }
      if (
        path === "/api/knowledge/repositories/repository-recovery/retry" &&
        init?.method === "POST"
      ) {
        return pendingRetry.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(
      screen.getByRole("button", { name: `View details for ${failedRepository.name}` }),
    );
    const details = screen.getByRole("dialog", { name: failedRepository.name });
    await user.click(within(details).getByRole("button", { name: "Retry clone" }));
    expect(await within(details).findByRole("button", { name: "Retrying…" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Switch to Product" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );

    await act(async () => {
      pendingRetry.resolve(jsonResponse(readyRepository));
    });
    await act(async () => {});

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Knowledge" })).toBeVisible();
    expect(screen.getByText("Product repository")).toBeVisible();
    expect(screen.queryByText("Recovery repository")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Switch to Nexestra" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByText("Repository recovered.")).not.toBeInTheDocument();
  });
});
