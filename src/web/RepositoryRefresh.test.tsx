// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData } from "../shared/contracts.js";
import { App } from "./App.js";

const now = "2026-09-02T12:00:00.000Z";
const evenLater = "2026-09-02T14:00:00.000Z";

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

const oldCommit = "a".repeat(40);
const freshCommit = "b".repeat(40);

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
  sourceCommit: oldCommit,
  sourceRef: "main",
  refreshedAt: now,
  createdAt: now,
  updatedAt: now,
};

const refreshedRepository = {
  ...repository,
  sourceCommit: freshCommit,
  refreshedAt: evenLater,
  updatedAt: evenLater,
};

const failedRefreshRepository = {
  ...repository,
  refreshError: "Remote is offline.",
  updatedAt: evenLater,
};

const productRepository = {
  ...repository,
  id: "repository-product-workspace",
  workspaceId: productWorkspace.id,
  name: "Product workspace repository",
  handle: "product",
  storagePath: "workspaces/workspace-product/repositories/product/source",
  sourceCommit: freshCommit,
  refreshedAt: evenLater,
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

describe("Repository source refresh", () => {
  it("updates the starting point and notices immediately without a bootstrap reload", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let bootstraps = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          knowledge: [repository],
        });
      }
      if (path === "/api/knowledge/repositories/repository-product/refresh") {
        return jsonResponse(refreshedRepository);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    const detailsButton = screen.getByRole("button", {
      name: `View details for ${repository.name}`,
    });
    const card = detailsButton.closest("article");
    if (!card) throw new Error("expected repository knowledge card");
    expect(within(card).getByText("ready")).toBeVisible();

    await user.click(detailsButton);
    const details = screen.getByRole("dialog", { name: repository.name });
    expect(within(details).getByText("Starting point for new Workers")).toBeVisible();
    expect(within(details).getByText(oldCommit)).toBeVisible();
    expect(within(details).getByText(/Refreshed .* from main\./)).toBeVisible();
    expect(within(details).getByRole("button", { name: "Refresh source" })).toBeEnabled();

    await user.click(within(details).getByRole("button", { name: "Refresh source" }));
    expect(await within(details).findByText(freshCommit)).toBeVisible();
    expect(within(details).getByText(/Refreshed .* from main\./)).toBeVisible();
    expect(screen.getByText("Repository source refreshed.")).toBeVisible();
    expect(within(details).queryByText("Source refresh failed")).not.toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Refresh source" })).toBeEnabled();

    await user.click(within(details).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("status")).toHaveTextContent("Repository source refreshed.");

    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    const reopened = screen.getByRole("dialog", { name: repository.name });
    expect(within(reopened).getByText(freshCommit)).toBeVisible();
    expect(within(reopened).getByText(/Refreshed .* from main\./)).toBeVisible();
    await user.click(within(reopened).getByRole("button", { name: "Done" }));
    expect(bootstraps).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge/repositories/repository-product/refresh",
      { method: "POST", headers: {} },
    );
  });

  it("keeps the last good starting point when a refresh fails and allows retry", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let bootstraps = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          knowledge: [repository],
        });
      }
      if (path === "/api/knowledge/repositories/repository-product/refresh") {
        return jsonResponse(failedRefreshRepository);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    const details = screen.getByRole("dialog", { name: repository.name });
    expect(within(details).getByText(oldCommit)).toBeVisible();
    expect(within(details).getByText(/Refreshed .* from main\./)).toBeVisible();

    await user.click(within(details).getByRole("button", { name: "Refresh source" }));
    expect(await within(details).findByText("Remote is offline.")).toBeVisible();
    expect(within(details).getByText("Source refresh failed")).toBeVisible();
    expect(
      within(details).getByText("The previous starting point is still selected."),
    ).toBeVisible();
    expect(within(details).getByText(oldCommit)).toBeVisible();
    expect(within(details).queryByText(freshCommit)).not.toBeInTheDocument();
    expect(within(details).queryByText("Repository source refreshed.")).not.toBeInTheDocument();
    const refreshButton = within(details).getByRole("button", { name: "Refresh source" });
    await waitFor(() => expect(refreshButton).toBeEnabled());

    await user.click(within(details).getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    const reopened = screen.getByRole("dialog", { name: repository.name });
    expect(within(reopened).getByText(oldCommit)).toBeVisible();
    expect(within(reopened).getByText("Remote is offline.")).toBeVisible();
    expect(within(reopened).getByRole("button", { name: "Refresh source" })).toBeEnabled();
    await user.click(within(reopened).getByRole("button", { name: "Done" }));
    expect(bootstraps).toBe(1);
  });

  it("does not reopen the details or toast when the request finishes after closing", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let bootstraps = 0;
    const pendingRefresh = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          knowledge: [repository],
        });
      }
      if (path === "/api/knowledge/repositories/repository-product/refresh") {
        return pendingRefresh.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    const details = screen.getByRole("dialog", { name: repository.name });
    await user.click(within(details).getByRole("button", { name: "Refresh source" }));
    expect(
      await within(details).findByRole("button", { name: "Refreshing source…" }),
    ).toBeDisabled();

    await user.click(within(details).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: repository.name })).not.toBeInTheDocument();

    await act(async () => {
      pendingRefresh.resolve(jsonResponse(refreshedRepository));
    });
    await act(async () => {});

    expect(screen.queryByRole("dialog", { name: repository.name })).not.toBeInTheDocument();
    expect(screen.queryByText("Repository source refreshed.")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    const reopened = screen.getByRole("dialog", { name: repository.name });
    expect(within(reopened).getByText(freshCommit)).toBeVisible();
    await user.click(within(reopened).getByRole("button", { name: "Done" }));
    expect(bootstraps).toBe(1);
  });

  it("ignores a stale response after switching away and back to the workspace", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let bootstraps = 0;
    const pendingRefresh = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          knowledge: [repository],
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
      if (path === "/api/knowledge/repositories/repository-product/refresh") {
        return pendingRefresh.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    const details = screen.getByRole("dialog", { name: repository.name });
    await user.click(within(details).getByRole("button", { name: "Refresh source" }));
    expect(
      await within(details).findByRole("button", { name: "Refreshing source…" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Switch to Product" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    await user.click(
      screen.getByRole("button", { name: `View details for ${productRepository.name}` }),
    );
    const productDetails = screen.getByRole("dialog", { name: productRepository.name });
    expect(within(productDetails).getByText(freshCommit)).toBeVisible();
    await user.click(within(productDetails).getByRole("button", { name: "Done" }));

    await user.click(screen.getByRole("button", { name: "Switch to Nexestra" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Nexestra" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    await act(async () => {
      pendingRefresh.resolve(jsonResponse(refreshedRepository));
    });
    await act(async () => {});

    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    const localDetails = screen.getByRole("dialog", { name: repository.name });
    expect(within(localDetails).getByText(oldCommit)).toBeVisible();
    expect(within(localDetails).queryByText(freshCommit)).not.toBeInTheDocument();
    await user.click(within(localDetails).getByRole("button", { name: "Done" }));
    expect(screen.getByRole("button", { name: "Switch to Nexestra" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository source refreshed.")).not.toBeInTheDocument();
    expect(bootstraps).toBe(2);
  });

  it("does not fetch the refresh endpoint or poll while idle", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const intervalSpy = vi.spyOn(window, "setInterval");
    const refreshCalls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({
          ...bootstrapData,
          knowledge: [repository],
        });
      }
      if (path === "/api/knowledge/repositories/repository-product/refresh") {
        refreshCalls.push(path);
        return jsonResponse(refreshedRepository);
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Knowledge" });
    expect(refreshCalls).toEqual([]);
    expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: `View details for ${repository.name}` }));
    expect(refreshCalls).toEqual([]);
    expect(intervalSpy.mock.calls.filter(([, delay]) => delay === 1_000)).toHaveLength(0);
  });
});
