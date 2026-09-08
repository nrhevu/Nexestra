// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../shared/contracts.js";
import { AttentionView } from "./AttentionView.js";

afterEach(cleanup);

const approval = (id: string, runId: string, threadId: string): AttentionItem => ({
  id,
  kind: "approval",
  title: `Approval ${runId}`,
  detail: "Review the pending tool request.",
  threadId,
  runId,
  updatedAt: "2026-09-08T00:00:00Z",
});

const task = (id: string, taskId: string, runId: string, threadId: string): AttentionItem => ({
  id,
  kind: "task_blocked",
  title: `Task ${taskId}`,
  detail: "The repository is unavailable.",
  threadId,
  taskId,
  runId,
  updatedAt: "2026-09-08T00:00:00Z",
});

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
      approval("run:approval", "approval-run", "thread-general"),
      task("task:blocked", "task-blocked", "worker-run", "thread-worker"),
    ];
    render(<AttentionView items={items} onThread={onThread} onTask={onTask} />);
    expect(onThread).not.toHaveBeenCalled();
    expect(onTask).not.toHaveBeenCalled();
    expect(screen.getByText("Approval requested")).toBeVisible();
    expect(screen.getByText("The repository is unavailable.")).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Open thread: Approval approval-run" }),
    );
    expect(onThread).toHaveBeenCalledExactlyOnceWith("thread-general");

    await userEvent.click(screen.getByRole("button", { name: "Inspect task: Task task-blocked" }));
    expect(onTask).toHaveBeenCalledExactlyOnceWith("task-blocked");
    expect(onThread).toHaveBeenCalledTimes(1);
  });

  it("resolves two pending runs in the same thread to their exact run ids", async () => {
    const onRun = vi.fn();
    const onThread = vi.fn();
    const onTask = vi.fn();
    const items: AttentionItem[] = [
      approval("run:one", "run-one", "thread-general"),
      approval("run:two", "run-two", "thread-general"),
    ];
    render(<AttentionView items={items} onThread={onThread} onTask={onTask} onRun={onRun} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Open run run-one: Approval run-one" }),
    );
    expect(onRun).toHaveBeenCalledExactlyOnceWith("thread-general", "run-one");
    expect(onThread).not.toHaveBeenCalled();
    expect(onTask).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Open run run-two: Approval run-two" }),
    );
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(onRun.mock.calls[1]).toEqual(["thread-general", "run-two"]);
    expect(onThread).not.toHaveBeenCalled();
    expect(onTask).not.toHaveBeenCalled();
  });

  it("falls back to opening the thread when run id exists but onRun is absent", async () => {
    const onThread = vi.fn();
    const onTask = vi.fn();
    render(
      <AttentionView
        items={[approval("run:fallback", "run-fallback", "thread-notes")]}
        onThread={onThread}
        onTask={onTask}
      />,
    );

    expect(screen.queryByRole("button", { name: /^Open run / })).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Open thread: Approval run-fallback" }),
    );
    expect(onThread).toHaveBeenCalledExactlyOnceWith("thread-notes");
  });

  it("keeps task precedence over run navigation when a task row also carries a run id", async () => {
    const onRun = vi.fn();
    const onThread = vi.fn();
    const onTask = vi.fn();
    render(
      <AttentionView
        items={[task("task:blocked", "task-blocked", "worker-run", "thread-worker")]}
        onThread={onThread}
        onTask={onTask}
        onRun={onRun}
      />,
    );

    expect(screen.getByRole("button", { name: "Inspect task: Task task-blocked" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Open run / })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Inspect task: Task task-blocked" }));
    expect(onTask).toHaveBeenCalledExactlyOnceWith("task-blocked");
    expect(onRun).not.toHaveBeenCalled();
    expect(onThread).not.toHaveBeenCalled();
  });
});
