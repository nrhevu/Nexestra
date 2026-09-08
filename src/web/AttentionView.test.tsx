// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../shared/contracts.js";
import { AttentionView } from "./AttentionView.js";

afterEach(cleanup);

describe("Needs attention", () => {
  it("explains the empty state without action buttons", () => {
    render(<AttentionView items={[]} onThread={vi.fn()} onTask={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Nothing needs your attention" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens pending decisions in their thread and task problems in their process", async () => {
    const onThread = vi.fn();
    const onTask = vi.fn();
    const items: AttentionItem[] = [
      {
        id: "run:approval",
        kind: "approval",
        title: "Planner in #general",
        detail: "Review the pending tool request.",
        threadId: "thread-general",
        runId: "approval",
        updatedAt: "2026-09-08T00:00:00Z",
      },
      {
        id: "task:blocked",
        kind: "task_blocked",
        title: "Update the release notes",
        detail: "The repository is unavailable.",
        threadId: "thread-worker",
        taskId: "task-blocked",
        runId: "worker-run",
        updatedAt: "2026-09-08T00:00:00Z",
      },
    ];
    render(<AttentionView items={items} onThread={onThread} onTask={onTask} />);
    expect(onThread).not.toHaveBeenCalled();
    expect(onTask).not.toHaveBeenCalled();
    expect(screen.getByText("Approval requested")).toBeVisible();
    expect(screen.getByText("The repository is unavailable.")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Open thread: Planner in #general" }));
    expect(onThread).toHaveBeenCalledExactlyOnceWith("thread-general");

    await userEvent.click(
      screen.getByRole("button", { name: "Inspect task: Update the release notes" }),
    );
    expect(onTask).toHaveBeenCalledExactlyOnceWith("task-blocked");
    expect(onThread).toHaveBeenCalledTimes(1);
  });
});
