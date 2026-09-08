// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BootstrapData,
  KnowledgeDocument,
  KnowledgeDocumentRevisions,
} from "../shared/contracts.js";
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

const revisionThree = {
  id: "rev-3",
  createdAt: later,
  fileName: "architecture-v3.md",
  mediaType: "text/markdown",
  size: 17,
  storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-3",
  sha256: "replacement-hash",
};

function documentItem(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: "knowledge-architecture",
    workspaceId: workspace.id,
    kind: "document",
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
    ...overrides,
  };
}

function revisionsPayload(doc: KnowledgeDocument): KnowledgeDocumentRevisions {
  return {
    currentRevisionId: doc.currentRevisionId,
    revisions: [...doc.revisions].reverse(),
  };
}

const productRevision = {
  id: "product-rev-1",
  createdAt: now,
  fileName: "product.md",
  mediaType: "text/markdown",
  size: 12,
  storagePath:
    "workspaces/workspace-product/knowledge/knowledge-product-guide/revisions/product-rev-1",
  sha256: "product-hash",
};

function productDocument(): KnowledgeDocument {
  return {
    id: "knowledge-product-guide",
    workspaceId: productWorkspace.id,
    kind: "document",
    name: "Product guide",
    handle: "product-guide",
    description: "",
    fileName: productRevision.fileName,
    mediaType: productRevision.mediaType,
    size: productRevision.size,
    storagePath: "workspaces/workspace-product/knowledge/knowledge-product-guide/document",
    revisions: [productRevision],
    currentRevisionId: "product-rev-1",
    createdAt: now,
    updatedAt: now,
  };
}

async function openDocumentDetails(user: ReturnType<typeof userEvent.setup>, name: string) {
  await screen.findByRole("heading", { name: "Knowledge" });
  await user.click(screen.getByRole("button", { name: `View details for ${name}` }));
  const details = screen.getByRole("dialog", { name });
  expect(await within(details).findByText("Version history")).toBeVisible();
  return details;
}

describe("Knowledge document revisions", () => {
  it("fetches version history when the detail view opens and keeps old revision downloads", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const doc = documentItem();
    let bootstraps = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({ ...bootstrapData, knowledge: [doc] });
      }
      if (path === `/api/knowledge/${doc.id}/revisions`) {
        return jsonResponse(revisionsPayload(doc));
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const details = await openDocumentDetails(user, doc.name);
    expect(within(details).getByRole("link", { name: "Download architecture.md" })).toHaveAttribute(
      "href",
      `/api/knowledge/${doc.id}/revisions/rev-1/content`,
    );
    expect(
      within(details).getByRole("link", { name: "Download architecture-v2.md" }),
    ).toHaveAttribute("href", `/api/knowledge/${doc.id}/revisions/rev-2/content`);
    expect(within(details).getByRole("button", { name: "Restore architecture.md" })).toBeVisible();
    expect(
      within(details).getByRole("button", { name: "Current architecture-v2.md" }),
    ).toBeDisabled();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === `/api/knowledge/${doc.id}/revisions`,
      ),
    ).toHaveLength(1);
    expect(bootstraps).toBe(1);
  });

  it("replaces the document with a real uploaded file and updates file and history without bootstrap", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let current = documentItem();
    let bootstraps = 0;
    let observedForm: FormData | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({ ...bootstrapData, knowledge: [current] });
      }
      if (path === `/api/knowledge/${current.id}/revisions`) {
        return jsonResponse(revisionsPayload(current));
      }
      if (path === `/api/knowledge/${current.id}/document` && init?.method === "PUT") {
        observedForm = init.body as FormData;
        const file = observedForm.get("file") as File | undefined;
        if (!file) return jsonResponse({ error: { message: "Missing file" } }, 400);
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
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const details = await openDocumentDetails(user, current.name);
    await user.upload(
      within(details).getByLabelText<HTMLInputElement>("Replacement file"),
      new File(["# Architecture v3"], "architecture-v3.md", {
        type: "text/markdown",
      }),
    );
    await user.click(within(details).getByRole("button", { name: "Replace" }));

    expect(
      await within(details).findByRole("button", { name: "Current architecture-v3.md" }),
    ).toBeVisible();
    expect(
      within(details).queryByRole("button", { name: "Current architecture-v2.md" }),
    ).not.toBeInTheDocument();
    expect(
      within(details).getByRole("button", { name: "Restore architecture-v2.md" }),
    ).toBeVisible();
    expect(
      within(details).getByRole("link", { name: "Download architecture-v2.md" }),
    ).toHaveAttribute("href", `/api/knowledge/${current.id}/revisions/rev-2/content`);
    expect(screen.getByText("Document replaced.")).toBeVisible();
    expect(observedForm?.get("expectedRevisionId")).toBe("rev-2");
    const sentFile = observedForm?.get("file") as File | undefined;
    expect(sentFile?.name).toBe("architecture-v3.md");
    expect(sentFile?.type).toBe("text/markdown");
    expect(fetchMock).toHaveBeenCalledWith(`/api/knowledge/${current.id}/document`, {
      method: "PUT",
      body: expect.any(FormData),
      headers: {},
    });

    await user.click(within(details).getByRole("button", { name: "Done" }));
    const cardButton = screen.getByRole("button", {
      name: `View details for ${current.name}`,
    });
    expect(within(cardButton).getByText("architecture-v3.md")).toBeVisible();
    expect(bootstraps).toBe(1);
  });

  it("restores an older revision as a new current without losing old downloads", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    let current = documentItem();
    let bootstraps = 0;
    let observedBody: { expectedRevisionId?: string } | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({ ...bootstrapData, knowledge: [current] });
      }
      if (path === `/api/knowledge/${current.id}/revisions`) {
        return jsonResponse(revisionsPayload(current));
      }
      if (path.endsWith("/revisions/rev-1/restore") && init?.method === "POST") {
        observedBody = JSON.parse(String(init.body)) as {
          expectedRevisionId?: string;
        };
        current = {
          ...current,
          fileName: revisionOne.fileName,
          mediaType: revisionOne.mediaType,
          size: revisionOne.size,
          currentRevisionId: "rev-3",
          revisions: [
            ...current.revisions,
            {
              id: "rev-3",
              createdAt: later,
              fileName: revisionOne.fileName,
              mediaType: revisionOne.mediaType,
              size: revisionOne.size,
              storagePath:
                "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-3",
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

    const details = await openDocumentDetails(user, current.name);
    await user.click(within(details).getByRole("button", { name: "Restore architecture.md" }));

    expect(
      await within(details).findByRole("button", { name: "Current architecture.md" }),
    ).toBeVisible();
    expect(within(details).getByText("Restored from a prior version")).toBeVisible();
    const architectureLinks = within(details).getAllByRole("link", {
      name: "Download architecture.md",
    });
    expect(architectureLinks).toHaveLength(2);
    expect(architectureLinks.map((link) => link.getAttribute("href"))).toEqual(
      expect.arrayContaining([
        `/api/knowledge/${current.id}/revisions/rev-1/content`,
        `/api/knowledge/${current.id}/revisions/rev-3/content`,
      ]),
    );
    expect(
      within(details).getByRole("link", { name: "Download architecture-v2.md" }),
    ).toHaveAttribute("href", `/api/knowledge/${current.id}/revisions/rev-2/content`);
    expect(screen.getByText("Document restored.")).toBeVisible();
    expect(observedBody?.expectedRevisionId).toBe("rev-2");
    expect(bootstraps).toBe(1);
  });

  it("keeps the current file and selection visible when a replacement conflicts", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const doc = documentItem();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        return jsonResponse({ ...bootstrapData, knowledge: [doc] });
      }
      if (path === `/api/knowledge/${doc.id}/revisions`) {
        return jsonResponse(revisionsPayload(doc));
      }
      if (path === `/api/knowledge/${doc.id}/document` && init?.method === "PUT") {
        return jsonResponse(
          {
            error: {
              code: "conflict",
              message: "This document changed since it was loaded.",
            },
          },
          409,
        );
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const details = await openDocumentDetails(user, doc.name);
    const replacementInput = within(details).getByLabelText<HTMLInputElement>("Replacement file");
    await user.upload(
      replacementInput,
      new File(["# Architecture v3"], "architecture-v3.md", {
        type: "text/markdown",
      }),
    );
    await user.click(within(details).getByRole("button", { name: "Replace" }));

    expect(
      await within(details).findByText("This document changed since it was loaded."),
    ).toBeVisible();
    expect(
      within(details).getByRole("button", { name: "Current architecture-v2.md" }),
    ).toBeDisabled();
    expect(within(details).getByRole("button", { name: "Replace" })).toBeEnabled();
    expect(replacementInput.files?.[0]?.name).toBe("architecture-v3.md");
    expect(screen.queryByText("Document replaced.")).not.toBeInTheDocument();
  });

  it("does not reopen or toast when a delayed replacement resolves after the dialog closes", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const current = documentItem();
    let bootstraps = 0;
    const pendingReplace = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) {
        bootstraps += 1;
        return jsonResponse({ ...bootstrapData, knowledge: [current] });
      }
      if (path === `/api/knowledge/${current.id}/revisions`) {
        return jsonResponse(revisionsPayload(current));
      }
      if (path === `/api/knowledge/${current.id}/document` && init?.method === "PUT") {
        return pendingReplace.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const details = await openDocumentDetails(user, current.name);
    await user.upload(
      within(details).getByLabelText<HTMLInputElement>("Replacement file"),
      new File(["# Architecture v3"], "architecture-v3.md", {
        type: "text/markdown",
      }),
    );
    await user.click(within(details).getByRole("button", { name: "Replace" }));
    expect(await within(details).findByRole("button", { name: "Replacing…" })).toBeDisabled();

    await user.click(within(details).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: current.name })).not.toBeInTheDocument();

    const replaced: KnowledgeDocument = {
      ...current,
      fileName: revisionThree.fileName,
      mediaType: revisionThree.mediaType,
      size: revisionThree.size,
      currentRevisionId: "rev-3",
      revisions: [...current.revisions, revisionThree],
      updatedAt: later,
    };
    await act(async () => {
      pendingReplace.resolve(jsonResponse(replaced));
    });

    const cardButton = screen.getByRole("button", {
      name: `View details for ${current.name}`,
    });
    await waitFor(() => expect(within(cardButton).getByText("architecture-v3.md")).toBeVisible());
    expect(screen.queryByRole("dialog", { name: current.name })).not.toBeInTheDocument();
    expect(screen.queryByText("Document replaced.")).not.toBeInTheDocument();
    expect(bootstraps).toBe(1);
  });

  it("ignores a delayed replacement after switching workspaces and cannot overwrite fresh state", async () => {
    window.localStorage.setItem("nexestra.workspaceId", workspace.id);
    window.history.replaceState({}, "", "/surfaces/knowledge");
    const doc = documentItem();
    const productDoc = productDocument();
    let bootstraps = 0;
    const pendingReplace = deferredResponse();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/bootstrap" || path === `/api/bootstrap?workspaceId=${workspace.id}`) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          knowledge: [doc],
        });
      }
      if (path === `/api/bootstrap?workspaceId=${productWorkspace.id}`) {
        bootstraps += 1;
        return jsonResponse({
          ...bootstrapData,
          workspaces: [workspace, productWorkspace],
          workspace: productWorkspace,
          knowledge: [productDoc],
        });
      }
      if (path === `/api/knowledge/${doc.id}/revisions`) {
        return jsonResponse(revisionsPayload(doc));
      }
      if (path === `/api/knowledge/${doc.id}/document` && init?.method === "PUT") {
        return pendingReplace.promise;
      }
      return jsonResponse({ error: { message: "Not found" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);

    const details = await openDocumentDetails(user, doc.name);
    await user.upload(
      within(details).getByLabelText<HTMLInputElement>("Replacement file"),
      new File(["# Architecture v3"], "architecture-v3.md", {
        type: "text/markdown",
      }),
    );
    await user.click(within(details).getByRole("button", { name: "Replace" }));
    expect(await within(details).findByRole("button", { name: "Replacing…" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Switch to Product" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Product" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(
      within(screen.getByRole("button", { name: "View details for Product guide" })).getByText(
        "product.md",
      ),
    ).toBeVisible();

    const replaced: KnowledgeDocument = {
      ...doc,
      fileName: revisionThree.fileName,
      mediaType: revisionThree.mediaType,
      size: revisionThree.size,
      currentRevisionId: "rev-3",
      revisions: [...doc.revisions, revisionThree],
      updatedAt: later,
    };
    await act(async () => {
      pendingReplace.resolve(jsonResponse(replaced));
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Document replaced.")).not.toBeInTheDocument();
    expect(screen.queryByText("Architecture guide")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Switch to Nexestra" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Switch to Nexestra" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    const cardButton = screen.getByRole("button", {
      name: "View details for Architecture guide",
    });
    expect(within(cardButton).getByText("architecture-v2.md")).toBeVisible();
    expect(within(cardButton).queryByText("architecture-v3.md")).not.toBeInTheDocument();
    expect(bootstraps).toBe(3);
  });
});
