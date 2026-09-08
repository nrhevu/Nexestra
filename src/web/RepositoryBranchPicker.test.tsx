// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRANCH_NAME_MAX_LENGTH,
  type BranchAwareRepository,
  RepositoryBranchPicker,
} from "./RepositoryBranchPicker.js";

const now = "2026-09-02T12:00:00.000Z";
const later = "2026-09-02T13:00:00.000Z";
const mainCommit = "a".repeat(40);
const devCommit = "b".repeat(40);

const repository: BranchAwareRepository = {
  id: "repository-product",
  workspaceId: "workspace-nexestra",
  kind: "repository",
  name: "Product repository",
  handle: "product-repo",
  description: "",
  source: "https://github.com/example/product.git",
  storagePath: "workspaces/workspace-nexestra/repositories/product/source",
  status: "ready",
  defaultBranch: "main",
  sourceCommit: mainCommit,
  sourceRef: "main",
  refreshedAt: now,
  sourceVersion: 3,
  createdAt: now,
  updatedAt: now,
};

const updatedRepository = {
  ...repository,
  selectedBranch: "develop",
  sourceVersion: 4,
  updatedAt: later,
};

function branchesResponse(
  overrides: Partial<{
    branches: Array<{ name: string; commit: string }>;
    truncated: boolean;
    sourceVersion: number;
    selectedBranch: string | null;
    defaultBranch: string | null;
  }> = {},
) {
  return {
    branches: [
      { name: "main", commit: mainCommit },
      { name: "develop", commit: devCommit },
    ],
    truncated: false,
    sourceVersion: 3,
    selectedBranch: null,
    defaultBranch: "main",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse() {
  let resolve: (response: Response) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<Response>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderPicker(
  props: Partial<{
    item: BranchAwareRepository;
    generation: number;
  }> = {},
) {
  const onChanged = vi.fn();
  const onPendingChange = vi.fn();
  render(
    <RepositoryBranchPicker
      item={props.item ?? repository}
      generation={props.generation ?? 0}
      onPendingChange={onPendingChange}
      onChanged={onChanged}
    />,
  );
  return { onChanged, onPendingChange };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Repository branch picker", () => {
  it("loads branches only after an explicit open and shows an empty list with manual entry", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse({ branches: [] }));
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return jsonResponse({ ...updatedRepository, selectedBranch: "feature/manual" });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onChanged } = renderPicker();

    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Change branch" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge/repository-product/branches",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      await screen.findByText("No branches were returned. Type a branch name above."),
    ).toBeVisible();

    const input = screen.getByLabelText("Branch name");
    expect(input).toHaveAttribute("maxlength", String(BRANCH_NAME_MAX_LENGTH));
    await user.type(input, "feature/manual");
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge/repository-product/source-branch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "feature/manual", expectedSourceVersion: 3 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(onChanged).toHaveBeenCalledWith(
      { ...updatedRepository, selectedBranch: "feature/manual" },
      0,
      "Source branch set to feature/manual.",
    );
    expect(screen.queryByLabelText("Change source branch")).not.toBeInTheDocument();
  });

  it("applies a listed branch selection with the current source version and then closes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse({ sourceVersion: 7 }));
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return jsonResponse({ ...updatedRepository, sourceVersion: 8 });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onChanged, onPendingChange } = renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    const develop = await screen.findByRole("button", { name: /develop/ });
    await user.click(develop);
    expect(screen.getByLabelText("Branch name")).toHaveValue("develop");
    expect(screen.getByRole("button", { name: "Apply branch" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge/repository-product/source-branch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "develop", expectedSourceVersion: 7 }),
      }),
    );
    expect(onChanged).toHaveBeenCalledWith(
      { ...updatedRepository, sourceVersion: 8 },
      0,
      "Source branch set to develop.",
    );
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("accepts a typed branch and applies it with Enter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse());
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return jsonResponse({ ...updatedRepository, selectedBranch: "feature/typed" });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onChanged } = renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    const input = await screen.findByLabelText("Branch name");
    await user.type(input, "feature/typed");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/knowledge/repository-product/source-branch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "feature/typed", expectedSourceVersion: 3 }),
      }),
    );
    expect(onChanged).toHaveBeenCalledWith(
      { ...updatedRepository, selectedBranch: "feature/typed" },
      0,
      "Source branch set to feature/typed.",
    );
  });

  it("marks a truncated list and still allows typing a branch name", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/knowledge/repository-product/branches") {
        return jsonResponse(
          branchesResponse({
            branches: [
              { name: "main", commit: mainCommit },
              { name: "develop", commit: devCommit },
              { name: "release", commit: "c".repeat(40) },
            ],
            truncated: true,
          }),
        );
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    expect(
      await screen.findByText(
        /Showing the first 3 branches\. You can type another branch name manually\./,
      ),
    ).toBeVisible();
    const input = screen.getByLabelText("Branch name");
    await user.type(input, "experiment/x");
    expect(screen.getByRole("button", { name: "Apply branch" })).toBeEnabled();
  });

  it("shows a load error and retries the branch list", async () => {
    let reads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/knowledge/repository-product/branches") {
        reads += 1;
        return reads === 1
          ? jsonResponse({ error: { message: "Git listing failed." } }, 500)
          : jsonResponse(branchesResponse());
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    expect(await screen.findByText("Git listing failed.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: /main/ })).toBeVisible();
    expect(reads).toBe(2);
  });

  it("does not treat a ready item with refreshError as success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse());
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return jsonResponse({
          ...repository,
          refreshError: "Remote is offline.",
          updatedAt: later,
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onChanged } = renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    await user.click(await screen.findByRole("button", { name: /develop/ }));
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    expect(await screen.findByText("Remote is offline.")).toBeVisible();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByLabelText("Branch name")).toHaveValue("develop");
    expect(screen.getByRole("button", { name: "Apply branch" })).toBeEnabled();
  });

  it("requires an explicit reload after a 409 before it will apply again", async () => {
    let applications = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse({ sourceVersion: applications === 0 ? 3 : 9 }));
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        applications += 1;
        if (applications === 1) {
          return jsonResponse(
            { error: { code: "SOURCE_VERSION_CONFLICT", message: "Source version changed." } },
            409,
          );
        }
        return jsonResponse({
          ...updatedRepository,
          selectedBranch: "developx",
          sourceVersion: 10,
        });
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onChanged } = renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    await user.click(await screen.findByRole("button", { name: /develop/ }));
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    expect(await screen.findByText("Source version changed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply branch" })).toBeDisabled();
    expect(onChanged).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Branch name"), "x");
    expect(screen.getByText("Source version changed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply branch" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Reload branches" }));
    expect(await screen.findByRole("button", { name: "Apply branch" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/knowledge/repository-product/source-branch",
      expect.objectContaining({
        body: JSON.stringify({ branch: "developx", expectedSourceVersion: 9 }),
      }),
    );
    expect(applications).toBe(2);
    expect(onChanged).toHaveBeenCalledWith(
      { ...updatedRepository, selectedBranch: "developx", sourceVersion: 10 },
      0,
      "Source branch set to developx.",
    );
  });

  it("ignores a late apply response after the picker closes", async () => {
    const pendingApply = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse());
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return pendingApply.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { onChanged, onPendingChange } = renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    await user.click(await screen.findByRole("button", { name: /develop/ }));
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      pendingApply.resolve(jsonResponse(updatedRepository));
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("ignores a late apply response after the component unmounts", async () => {
    const pendingApply = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse());
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return pendingApply.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const onPendingChange = vi.fn();
    const { unmount } = render(
      <RepositoryBranchPicker
        item={repository}
        generation={0}
        onPendingChange={onPendingChange}
        onChanged={onChanged}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    await user.click(await screen.findByRole("button", { name: /develop/ }));
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    unmount();
    await act(async () => {
      pendingApply.resolve(jsonResponse(updatedRepository));
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("ignores a late apply response after the item source version changes", async () => {
    const pendingApply = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse({ sourceVersion: 42 }));
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return pendingApply.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const onPendingChange = vi.fn();
    const { rerender } = render(
      <RepositoryBranchPicker
        item={repository}
        generation={0}
        onPendingChange={onPendingChange}
        onChanged={onChanged}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    await user.click(await screen.findByRole("button", { name: /develop/ }));
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    rerender(
      <RepositoryBranchPicker
        item={{ ...repository, sourceVersion: 99 }}
        generation={0}
        onPendingChange={onPendingChange}
        onChanged={onChanged}
      />,
    );
    await act(async () => {
      pendingApply.resolve(jsonResponse(updatedRepository));
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(await screen.findByRole("button", { name: "Apply branch" })).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/branches")).length,
    ).toBe(2);
  });

  it("ignores a rejected late apply after the workspace generation changes", async () => {
    const pendingApply = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse());
      }
      if (path === "/api/knowledge/repository-product/source-branch") {
        return pendingApply.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const onPendingChange = vi.fn();
    const { rerender } = render(
      <RepositoryBranchPicker
        item={repository}
        generation={0}
        onPendingChange={onPendingChange}
        onChanged={onChanged}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    await user.click(await screen.findByRole("button", { name: /develop/ }));
    await user.click(screen.getByRole("button", { name: "Apply branch" }));
    rerender(
      <RepositoryBranchPicker
        item={repository}
        generation={7}
        onPendingChange={onPendingChange}
        onChanged={onChanged}
      />,
    );
    await act(async () => {
      pendingApply.reject(new Error("Network down"));
    });
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Network down")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(await screen.findByRole("button", { name: "Apply branch" })).toBeEnabled();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it("ignores a late branch list response after the picker closes", async () => {
    const pendingList = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/knowledge/repository-product/branches") {
        return pendingList.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    expect(screen.getByText("Loading branches…")).toBeVisible();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      pendingList.resolve(jsonResponse(branchesResponse()));
    });
    expect(screen.queryByLabelText("Change source branch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change branch" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("focuses the branch input on open and restores focus to the trigger on Escape", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse());
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPicker();

    const trigger = screen.getByRole("button", { name: "Change branch" });
    await user.click(trigger);
    expect(screen.getByLabelText("Branch name")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("finishes loading under StrictMode without leaving the picker stuck", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/knowledge/repository-product/branches") {
        return jsonResponse(branchesResponse());
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <StrictMode>
        <RepositoryBranchPicker
          item={repository}
          generation={0}
          onPendingChange={() => {}}
          onChanged={() => {}}
        />
      </StrictMode>,
    );

    await user.click(screen.getByRole("button", { name: "Change branch" }));
    expect(await screen.findByRole("button", { name: /develop/ })).toBeVisible();
    expect(screen.queryByText("Loading branches…")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/branches")).length,
    ).toBeGreaterThan(0);
  });
});
