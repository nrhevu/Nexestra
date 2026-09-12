// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentRevisions } from "../shared/contracts.js";
import { KnowledgeRevisionComparison } from "./KnowledgeRevisionComparison.js";

const revisions: KnowledgeDocumentRevisions = {
  currentRevisionId: "rev-2",
  revisions: [
    {
      id: "rev-2",
      createdAt: "2026-09-02T13:00:00.000Z",
      fileName: "guide-v2.md",
      mediaType: "text/markdown",
      size: 18,
      storagePath: "storage/rev-2",
      sha256: "b".repeat(64),
    },
    {
      id: "rev-1",
      createdAt: "2026-09-02T12:00:00.000Z",
      fileName: "guide.md",
      mediaType: "text/markdown",
      size: 16,
      storagePath: "storage/rev-1",
      sha256: "a".repeat(64),
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("KnowledgeRevisionComparison", () => {
  it("shows added and removed lines for two text revisions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      return jsonResponse(
        path.includes("rev-1")
          ? {
              revisionId: "rev-1",
              isCurrent: false,
              fileName: "guide.md",
              mediaType: "text/markdown",
              size: 16,
              sha256: "a".repeat(64),
              supported: true,
              truncated: false,
              text: "keep\nold",
            }
          : {
              revisionId: "rev-2",
              isCurrent: true,
              fileName: "guide-v2.md",
              mediaType: "text/markdown",
              size: 18,
              sha256: "b".repeat(64),
              supported: true,
              truncated: false,
              text: "keep\nnew\nextra",
            },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<KnowledgeRevisionComparison documentId="knowledge-guide" revisions={revisions} />);

    await user.click(screen.getByRole("checkbox", { name: "Select guide.md for comparison" }));
    await user.click(screen.getByRole("checkbox", { name: "Select guide-v2.md for comparison" }));
    await user.click(screen.getByRole("button", { name: "Compare selected" }));

    const diff = await screen.findByRole("region", { name: "Revision line diff" });
    expect(diff).toHaveTextContent("- old");
    expect(diff).toHaveTextContent("+ new");
    expect(diff).toHaveTextContent("+ extra");
    expect(screen.getByText("+2 lines · -1 lines")).toBeVisible();
  });

  it("falls back to metadata when a revision is not text-previewable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          revisionId: "rev-1",
          isCurrent: false,
          fileName: "guide.md",
          mediaType: "application/pdf",
          size: 16,
          sha256: "a".repeat(64),
          supported: false,
          truncated: false,
          reason: "This file type cannot be previewed as plain text. Download it instead.",
        }),
      ),
    );
    const user = userEvent.setup();
    render(<KnowledgeRevisionComparison documentId="knowledge-guide" revisions={revisions} />);
    await user.click(screen.getByRole("checkbox", { name: "Select guide.md for comparison" }));
    await user.click(screen.getByRole("checkbox", { name: "Select guide-v2.md for comparison" }));
    await user.click(screen.getByRole("button", { name: "Compare selected" }));
    expect(await screen.findByText(/Metadata-only comparison/)).toBeVisible();
  });
});
