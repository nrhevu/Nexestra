// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocument } from "../shared/contracts.js";
import {
  KnowledgeDocumentPreview,
  type KnowledgeDocumentPreviewHandle,
} from "./KnowledgeDocumentPreview.js";

const now = "2026-09-02T12:00:00.000Z";
const later = "2026-09-02T13:00:00.000Z";

const revisionOne = {
  id: "rev-1",
  createdAt: now,
  fileName: "architecture.md",
  mediaType: "text/markdown",
  size: 18,
  storagePath: "storage/rev-1",
  sha256: "old-hash",
};
const revisionTwo = {
  id: "rev-2",
  createdAt: later,
  fileName: "architecture-v2.md",
  mediaType: "text/markdown",
  size: 22,
  storagePath: "storage/rev-2",
  sha256: "new-hash",
};

const document: KnowledgeDocument = {
  id: "knowledge-architecture",
  workspaceId: "workspace-nexestra",
  kind: "document",
  name: "Architecture guide",
  handle: "architecture",
  description: "",
  fileName: revisionTwo.fileName,
  mediaType: revisionTwo.mediaType,
  size: revisionTwo.size,
  storagePath: "workspaces/workspace-nexestra/knowledge/knowledge-architecture/revisions/rev-2",
  revisions: [revisionOne, revisionTwo],
  currentRevisionId: "rev-2",
  createdAt: now,
  updatedAt: later,
};

const revisions = {
  currentRevisionId: "rev-2",
  revisions: [revisionTwo, revisionOne],
};

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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function previewResult(overrides: Record<string, unknown> = {}) {
  return {
    revisionId: "rev-2",
    isCurrent: true,
    fileName: "architecture-v2.md",
    mediaType: "text/markdown",
    size: 22,
    sha256: "new-hash",
    createdAt: later,
    supported: true,
    truncated: false,
    text: "# Architecture v2",
    ...overrides,
  };
}

function renderPreview(handle?: RefObject<KnowledgeDocumentPreviewHandle | null>) {
  return render(
    <KnowledgeDocumentPreview
      ref={handle ?? createRef<KnowledgeDocumentPreviewHandle>()}
      document={document}
      revisions={revisions}
    />,
  );
}

describe("KnowledgeDocumentPreview", () => {
  it("previews current plain text and never renders HTML, scripts, or images", async () => {
    const text = "<img src=x onerror=alert(1)><script>alert(1)</script># v2";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/knowledge/${document.id}/preview`);
      return jsonResponse(previewResult({ text, truncated: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPreview();

    expect(
      screen.getByText(
        "Choose Preview current or a version below to read this file as plain text.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Preview current" }));

    const region = await screen.findByRole("region", { name: "Document preview" });
    expect(region.textContent).toContain(text);
    expect(region.textContent).toContain("Current version");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(globalThis.document.querySelector("script")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Preview is truncated to the first 128 KiB. Download the file to read it in full.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Download previewed architecture-v2.md" }),
    ).toHaveAttribute("href", `/api/knowledge/${document.id}/revisions/rev-2/content`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("previews a selected historical revision with its own download link", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/knowledge/${document.id}/preview?revisionId=rev-1`);
      return jsonResponse(
        previewResult({
          revisionId: "rev-1",
          isCurrent: false,
          fileName: "architecture.md",
          size: 18,
          sha256: "old-hash",
          createdAt: now,
          text: "# Architecture v1",
          truncated: false,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const handle = createRef<KnowledgeDocumentPreviewHandle>();
    renderPreview(handle);

    act(() => {
      handle.current?.selectRevision("rev-1");
    });

    expect(await screen.findByText("# Architecture v1")).toBeVisible();
    expect(screen.getByText(/Prior version/)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Download previewed architecture.md" }),
    ).toHaveAttribute("href", `/api/knowledge/${document.id}/revisions/rev-1/content`);
  });

  it("shows an unsupported binary state with a download fallback", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        previewResult({
          fileName: "diagram.png",
          mediaType: "image/png",
          supported: false,
          text: undefined,
          reason: "This file type cannot be previewed as plain text. Download it instead.",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole("button", { name: "Preview current" }));

    expect(
      await screen.findByText(
        "This file type cannot be previewed as plain text. Download it instead.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Download previewed diagram.png" })).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("retries after an error and disables pending controls", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) throw new Error("Preview failed to load.");
      return jsonResponse(previewResult());
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPreview();
    await user.click(screen.getByRole("button", { name: "Preview current" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Preview failed to load.");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("# Architecture v2")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores a slower prior response after switching versions", async () => {
    const current = deferredResponse();
    const old = deferredResponse();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.signal) signals.push(init.signal);
      if (url.includes("revisionId=rev-1")) return old.promise;
      return current.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const handle = createRef<KnowledgeDocumentPreviewHandle>();
    renderPreview(handle);
    act(() => {
      handle.current?.selectRevision("rev-2");
    });
    act(() => {
      handle.current?.selectRevision("rev-1");
    });
    expect(signals[0]?.aborted).toBe(true);

    act(() => {
      old.resolve(
        jsonResponse(
          previewResult({
            revisionId: "rev-1",
            isCurrent: false,
            fileName: "architecture.md",
            text: "# Architecture v1",
            createdAt: now,
          }),
        ),
      );
    });
    expect(await screen.findByText("# Architecture v1")).toBeVisible();
    act(() => {
      current.resolve(jsonResponse(previewResult({ text: "# Architecture v2" })));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByText("# Architecture v1")).toBeVisible();
    expect(screen.queryByText("# Architecture v2")).not.toBeInTheDocument();
  });

  it("resets and ignores stale previews when the document identity changes", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender } = renderPreview();
    await user.click(screen.getByRole("button", { name: "Preview current" }));
    expect(screen.getByText("Loading preview…")).toBeVisible();
    const otherDocument: KnowledgeDocument = {
      ...document,
      id: "knowledge-product",
      workspaceId: "workspace-product",
    };
    rerender(
      <KnowledgeDocumentPreview
        ref={createRef<KnowledgeDocumentPreviewHandle>()}
        document={otherDocument}
        revisions={revisions}
      />,
    );
    expect(screen.getByRole("button", { name: "Preview current" })).toBeEnabled();
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
    act(() => {
      deferred.resolve(jsonResponse(previewResult({ text: "# Architecture v1" })));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("# Architecture v1")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Choose Preview current or a version below to read this file as plain text.",
      ),
    ).toBeVisible();
  });

  it("clears stale previews while replacing or restoring", async () => {
    const deferred = deferredResponse();
    const fetchMock = vi.fn(() => deferred.promise);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const { rerender } = renderPreview();
    await user.click(screen.getByRole("button", { name: "Preview current" }));
    expect(screen.getByText("Loading preview…")).toBeVisible();

    rerender(
      <KnowledgeDocumentPreview
        ref={createRef<KnowledgeDocumentPreviewHandle>()}
        document={document}
        revisions={revisions}
        disabled={true}
      />,
    );
    expect(screen.getByRole("button", { name: "Preview current" })).toBeDisabled();
    expect(screen.queryByText("Loading preview…")).not.toBeInTheDocument();
    act(() => {
      deferred.resolve(jsonResponse(previewResult()));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("# Architecture v2")).not.toBeInTheDocument();
  });
});
