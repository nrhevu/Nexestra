// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomSurface } from "../shared/contracts.js";
import { CustomSurfaceView } from "./CustomSurfaceView.js";

afterEach(cleanup);

const surface: CustomSurface = {
  id: "inference",
  title: "Inference lab",
  description: "A focused workspace for model experiments.",
  cards: [
    {
      id: "profiles",
      title: "Model profiles",
      description: "Compare configured agents and costs.",
      action: "agents",
    },
    { id: "runs", title: "Active runs", description: "", action: "runs" },
    { id: "budget", title: "Budget watch", description: "", action: "over_budget" },
    { id: "reviews", title: "Needs-work", description: "", action: "reviews" },
    { id: "blocked", title: "Blocked tasks", description: "", action: "blocked_tasks" },
    { id: "ready", title: "Ready tasks", description: "", action: "ready_tasks" },
    { id: "new", title: "New task", description: "", action: "new_task" },
    { id: "new-knowledge", title: "New Knowledge", description: "", action: "new_knowledge" },
    { id: "new-agent", title: "New agent", description: "", action: "new_agent" },
  ],
};

describe("CustomSurfaceView", () => {
  it("renders configured cards and dispatches their safe built-in action", async () => {
    const onAction = vi.fn();
    render(
      <CustomSurfaceView
        surface={surface}
        counts={{
          agents: 3,
          runs: 2,
          reviews: 4,
          over_budget: 1,
          blocked_tasks: 2,
          ready_tasks: 1,
        }}
        onAction={onAction}
      />,
    );
    expect(screen.getByRole("heading", { name: "Inference lab" })).toBeVisible();
    expect(screen.getByText("Compare configured agents and costs.")).toBeVisible();
    expect(screen.getByText("3 matching items")).toBeVisible();
    expect(screen.getAllByText("2 matching items")).toHaveLength(2);
    expect(screen.getByText("4 matching items")).toBeVisible();
    expect(screen.getAllByText("1 matching items")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Open Agents" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("agents");
    await userEvent.click(screen.getByRole("button", { name: "Open over-budget runs" }));
    expect(onAction).toHaveBeenLastCalledWith("over_budget");
    await userEvent.click(screen.getByRole("button", { name: "Open blocked tasks" }));
    expect(onAction).toHaveBeenLastCalledWith("blocked_tasks");
    await userEvent.click(screen.getByRole("button", { name: "Open ready tasks" }));
    expect(onAction).toHaveBeenLastCalledWith("ready_tasks");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(onAction).toHaveBeenLastCalledWith("new_task");
    await userEvent.click(screen.getByRole("button", { name: "Create Knowledge" }));
    expect(onAction).toHaveBeenLastCalledWith("new_knowledge");
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(onAction).toHaveBeenLastCalledWith("new_agent");
  });
});
