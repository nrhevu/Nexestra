// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "../shared/contracts.js";
import { AttentionView } from "./AttentionView.js";

afterEach(cleanup);

const approval = (
  id: string,
  runId: string,
  threadId: string,
  title = `Approval ${runId}`,
): AttentionItem => ({
  id,
  kind: "approval",
  title,
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

  it("resolves two pending runs with the same visible title to their exact run ids", async () => {
    const onRun = vi.fn();
    const onThread = vi.fn();
    const onTask = vi.fn();
    const items: AttentionItem[] = [
      approval("run:one", "run-one", "thread-general", "Planner in #general"),
      approval("run:two", "run-two", "thread-general", "Planner in #general"),
    ];
    render(<AttentionView items={items} onThread={onThread} onTask={onTask} onRun={onRun} />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open run: Planner in #general" })).toHaveLength(
      2,
    );
    expect(screen.queryByText("run-one")).not.toBeInTheDocument();
    expect(screen.queryByText("run-two")).not.toBeInTheDocument();

    await userEvent.click(
      within(rows[0] as HTMLElement).getByRole("button", { name: "Open run: Planner in #general" }),
    );
    expect(onRun).toHaveBeenCalledExactlyOnceWith("thread-general", "run-one");
    expect(onThread).not.toHaveBeenCalled();
    expect(onTask).not.toHaveBeenCalled();

    await userEvent.click(
      within(rows[1] as HTMLElement).getByRole("button", { name: "Open run: Planner in #general" }),
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

    expect(
      screen.queryByRole("button", { name: "Open run: Approval run-fallback" }),
    ).not.toBeInTheDocument();
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
    expect(
      screen.queryByRole("button", { name: "Open run: Task task-blocked" }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Inspect task: Task task-blocked" }));
    expect(onTask).toHaveBeenCalledExactlyOnceWith("task-blocked");
    expect(onRun).not.toHaveBeenCalled();
    expect(onThread).not.toHaveBeenCalled();
  });

  it("offers snooze and dismiss actions for each item", async () => {
    const onSnooze = vi.fn();
    const onDismiss = vi.fn();
    const item: AttentionItem = {
      id: "task:one",
      kind: "task_blocked",
      title: "Blocked task",
      detail: "Needs attention",
      taskId: "one",
      updatedAt: "2026-09-12T00:00:00.000Z",
    };
    render(
      <AttentionView
        items={[item]}
        onThread={vi.fn()}
        onTask={vi.fn()}
        onSnooze={onSnooze}
        onDismiss={onDismiss}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Snooze 1h" }));
    await userEvent.click(screen.getByRole("button", { name: "4h" }));
    await userEvent.click(screen.getByRole("button", { name: "1d" }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onSnooze).toHaveBeenCalledWith(item.id);
    expect(onSnooze).toHaveBeenCalledWith(item.id, 240);
    expect(onSnooze).toHaveBeenCalledWith(item.id, 1440);
    expect(onDismiss).toHaveBeenCalledWith(item.id);
  });

  it("loads a bounded recent-action history only when explicitly refreshed", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => [
            {
              workspaceId: "workspace-a",
              attentionId: "task:one",
              kind: "task_blocked",
              action: "dismiss",
              createdAt: "2026-09-12T00:00:00.000Z",
            },
          ],
        }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AttentionView workspaceId="workspace-a" items={[]} onThread={vi.fn()} onTask={vi.fn()} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByText("Dismissed · task_blocked")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/attention/history?workspaceId=workspace-a",
      expect.anything(),
    );
    vi.unstubAllGlobals();
  });
});
