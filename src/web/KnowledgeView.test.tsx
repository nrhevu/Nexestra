// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData, KnowledgeItem } from "../shared/contracts.js";
import { filterKnowledgeItems, KnowledgeView } from "./App.js";

afterEach(cleanup);

const workspace = {
  id: "workspace-one",
  name: "Workspace",
  slug: "workspace",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
};

const documentItem = (id: string, name: string, workspaceId = workspace.id) =>
  ({
    id,
    workspaceId,
    kind: "document",
    name,
    handle: name.toLowerCase().replaceAll(" ", "-"),
    description: "Release decisions",
    fileName: `${id}.md`,
    mediaType: "text/markdown",
    size: 10,
    storagePath: "managed/document",
    revisions: [],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }) as KnowledgeItem;

const repositoryItem = (id: string, source: string) =>
  ({
    id,
    workspaceId: workspace.id,
    kind: "repository",
    name: "Service source",
    handle: "service-source",
    description: "Backend implementation",
    source,
    storagePath: "managed/repository",
    status: "ready",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }) as KnowledgeItem;

function renderKnowledge(items: KnowledgeItem[]) {
  return render(
    <KnowledgeView
      data={{ workspace, knowledge: items, assignments: [] } as unknown as BootstrapData}
      onCreate={vi.fn()}
      onInspect={vi.fn()}
    />,
  );
}

describe("KnowledgeView search", () => {
  it("matches selected-workspace metadata case-insensitively", async () => {
    renderKnowledge([
      documentItem("guide", "Architecture Guide"),
      repositoryItem("source", "https://github.com/acme/service"),
      documentItem("foreign", "Foreign Guide", "workspace-two"),
    ]);
    expect(
      screen.getByRole("button", { name: "View details for Architecture Guide" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "View details for Foreign Guide" }),
    ).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Search knowledge" }), "GITHUB.COM");
    expect(screen.getByRole("button", { name: "View details for Service source" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "View details for Architecture Guide" }),
    ).not.toBeInTheDocument();
  });

  it("filters by kind and reports no results without removing actions", async () => {
    const onInspect = vi.fn();
    render(
      <KnowledgeView
        data={
          {
            workspace,
            knowledge: [documentItem("guide", "Guide"), repositoryItem("source", "local/source")],
            assignments: [],
          } as unknown as BootstrapData
        }
        onCreate={vi.fn()}
        onInspect={onInspect}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Documents (1)" }));
    expect(screen.getByRole("button", { name: "View details for Guide" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "View details for Service source" }),
    ).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "Search knowledge" }), "missing");
    expect(screen.getByRole("heading", { name: "No matching knowledge" })).toBeVisible();
    expect(screen.getByText("0 matching items")).toBeVisible();
  });

  it("keeps filtering logic bounded to metadata fields", () => {
    const items = [
      documentItem("guide", "Architecture Guide"),
      repositoryItem("source", "local/source"),
    ];
    expect(filterKnowledgeItems(items, workspace.id, "architecture", "all")).toHaveLength(1);
    expect(filterKnowledgeItems(items, workspace.id, "local/source", "repository")).toHaveLength(1);
    expect(filterKnowledgeItems(items, workspace.id, "private transcript", "all")).toHaveLength(0);
  });
});
