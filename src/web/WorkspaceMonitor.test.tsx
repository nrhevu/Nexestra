// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceActivitySummary } from "../shared/contracts.js";
import { formatWorkspaceActivityAge, WorkspaceMonitor } from "./WorkspaceMonitor.js";

afterEach(cleanup);

const workspace = (id: string, name: string, archived = false): Workspace => ({
  id,
  name,
  slug: id,
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  ...(archived ? { archived: true } : {}),
});

describe("WorkspaceMonitor", () => {
  it("shows count-only cross-workspace activity and archived names", () => {
    render(
      <WorkspaceMonitor
        activeWorkspaceId="workspace-a"
        workspaces={[workspace("workspace-a", "Alpha"), workspace("workspace-b", "Beta")]}
        archivedWorkspaces={[workspace("workspace-old", "Old", true)]}
        summaries={[
          {
            workspaceId: "workspace-a",
            attentionCount: 2,
            activeRunCount: 1,
            observedAt: "2026-09-13T00:00:00.000Z",
          },
          { workspaceId: "workspace-b", attentionCount: 0, activeRunCount: 0 },
        ]}
        onWorkspace={vi.fn()}
        onAttention={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Monitor" })).toBeVisible();
    expect(screen.getByText("1 active")).toBeVisible();
    expect(screen.getByText("2 attention")).toBeVisible();
    expect(screen.getByText("Archived workspace")).toBeVisible();
    expect(screen.queryByText("Provider error")).not.toBeInTheDocument();
  });

  it("opens a workspace or its attention view through explicit callbacks", async () => {
    const onWorkspace = vi.fn();
    const onAttention = vi.fn();
    render(
      <WorkspaceMonitor
        activeWorkspaceId="workspace-a"
        workspaces={[workspace("workspace-a", "Alpha"), workspace("workspace-b", "Beta")]}
        summaries={[
          { workspaceId: "workspace-a", attentionCount: 1, activeRunCount: 0 },
          { workspaceId: "workspace-b", attentionCount: 1, activeRunCount: 2 },
        ]}
        onWorkspace={onWorkspace}
        onAttention={onAttention}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(onWorkspace).toHaveBeenCalledExactlyOnceWith("workspace-b");
    const attentionButtons = screen.getAllByRole("button", { name: "Needs attention" });
    const betaAttention = attentionButtons[1];
    expect(betaAttention).toBeDefined();
    if (!betaAttention) throw new Error("expected Beta attention button");
    await userEvent.click(betaAttention);
    expect(onAttention).toHaveBeenCalledExactlyOnceWith("workspace-b");
  });

  it("formats observed age with a stable clock", () => {
    const summary: WorkspaceActivitySummary = {
      workspaceId: "workspace-a",
      attentionCount: 0,
      activeRunCount: 0,
      observedAt: "2026-09-13T00:00:00.000Z",
    };
    expect(
      formatWorkspaceActivityAge(summary.observedAt, Date.parse("2026-09-13T01:00:00.000Z")),
    ).toBe("Observed 1h ago");
  });
});
