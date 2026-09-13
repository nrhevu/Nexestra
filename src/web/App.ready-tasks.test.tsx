// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData, Task, WorkAssignment } from "../shared/contracts.js";
import { App, isReadyTask, summarizeTaskPlans, Taskboard } from "./App.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

const task = (status: Task["status"], id = "task-1"): Task => ({
  id,
  workspaceId: "workspace-1",
  title: `Task ${id}`,
  description: "",
  status,
  assigneeId: null,
  threadId: null,
  verificationCommand: "",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
});

const assignment = (status: WorkAssignment["status"], taskId = "task-1"): WorkAssignment => ({
  id: "assignment-1",
  workspaceId: "workspace-1",
  taskId,
  threadId: "thread-1",
  masterRunId: "run-1",
  workerAgentId: "agent-1",
  repositoryId: "repo-1",
  status,
  branch: "nexestra/assignment-1",
  worktreePath: "worktree",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
});

describe("isReadyTask", () => {
  it("requires todo status and no active assignment", () => {
    expect(isReadyTask(task("todo"), [])).toBe(true);
    expect(isReadyTask(task("in_progress"), [])).toBe(false);
    expect(isReadyTask(task("todo"), [assignment("queued")])).toBe(false);
    expect(isReadyTask(task("todo"), [assignment("running")])).toBe(false);
    expect(isReadyTask(task("todo"), [assignment("completed")])).toBe(true);
  });

  it("routes a custom-surface action to the ready Taskboard filter", async () => {
    const ready = {
      ...task("todo", "ready"),
      planId: "00000000-0000-4000-8000-000000000001",
      planTitle: "Implementation plan",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          workspaces: [
            {
              id: "workspace-1",
              name: "Workspace",
              slug: "workspace",
              createdAt: "2026-09-13T00:00:00.000Z",
              updatedAt: "2026-09-13T00:00:00.000Z",
            },
          ],
          workspace: {
            id: "workspace-1",
            name: "Workspace",
            slug: "workspace",
            createdAt: "2026-09-13T00:00:00.000Z",
            updatedAt: "2026-09-13T00:00:00.000Z",
          },
          agents: [],
          threads: [],
          tasks: [ready],
          knowledge: [],
          customSurfaces: [
            {
              id: "dispatch",
              title: "Dispatch",
              description: "",
              cards: [
                { id: "ready", title: "Ready tasks", description: "", action: "ready_tasks" },
                { id: "agent", title: "New agent", description: "", action: "new_agent" },
              ],
            },
          ],
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
        }),
      ),
    );
    window.history.replaceState({}, "", "/surfaces/custom/dispatch");
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Create agent" }));
    expect(screen.getByRole("heading", { name: "Create agent" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(await screen.findByRole("button", { name: "Open ready tasks" }));
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/surfaces/taskboard?filter=ready",
    );
    expect(screen.getAllByText("Task ready")[0]).toBeVisible();
    expect(screen.getByText("Plan: Implementation plan")).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear ready filter" })).toBeVisible();
  });

  it("shows only ready tasks and clears the transient filter", async () => {
    const ready = task("todo", "ready");
    const active = task("todo", "active");
    const finishedAssignment = task("todo", "finished-assignment");
    const inProgress = task("in_progress", "in-progress");
    const onClearReadyFilter = vi.fn();
    render(
      <Taskboard
        data={
          {
            tasks: [ready, active, finishedAssignment, inProgress],
            assignments: [
              assignment("running", active.id),
              assignment("completed", finishedAssignment.id),
            ],
            agents: [],
          } as unknown as BootstrapData
        }
        readyOnly
        onClearReadyFilter={onClearReadyFilter}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onThread={vi.fn()}
        onInspect={vi.fn()}
      />,
    );

    expect(screen.getByText("Task ready")).toBeVisible();
    expect(screen.getByText("Task finished-assignment")).toBeVisible();
    expect(screen.queryByText("Task active")).not.toBeInTheDocument();
    expect(screen.queryByText("Task in-progress")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear ready filter" }));
    expect(onClearReadyFilter).toHaveBeenCalledOnce();
  });
});

describe("summarizeTaskPlans", () => {
  it("groups planned tasks and uses the latest assignment state", () => {
    const planned = (id: string, status: Task["status"]): Task => ({
      ...task(status, id),
      planId: "plan-1",
      planTitle: "Launch plan",
    });
    const summary = summarizeTaskPlans(
      [
        planned("ready", "todo"),
        planned("queued", "todo"),
        planned("running", "in_progress"),
        planned("blocked", "blocked"),
        planned("done", "done"),
        { ...task("todo", "legacy"), planId: undefined, planTitle: undefined },
      ],
      [
        { ...assignment("queued", "queued"), updatedAt: "2026-09-13T00:00:00.000Z" },
        { ...assignment("completed", "queued"), updatedAt: "2026-09-13T01:00:00.000Z" },
        { ...assignment("queued", "running"), updatedAt: "2026-09-13T00:00:00.000Z" },
        { ...assignment("running", "running"), updatedAt: "2026-09-13T01:00:00.000Z" },
      ],
    );

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      id: "plan-1",
      title: "Launch plan",
      total: 5,
      ready: 1,
      delegated: 1,
      queued: 0,
      running: 1,
      blocked: 1,
      done: 1,
    });
    expect(summary[0]?.tasks.map(({ id }) => id)).toEqual([
      "ready",
      "queued",
      "running",
      "blocked",
      "done",
    ]);
  });

  it("links each plan task to the existing inspection callback", async () => {
    const planned = {
      ...task("todo", "planned"),
      planId: "plan-1",
      planTitle: "Launch plan",
    };
    const onInspect = vi.fn();
    render(
      <Taskboard
        data={{ tasks: [planned], assignments: [], agents: [] } as unknown as BootstrapData}
        onClearReadyFilter={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onThread={vi.fn()}
        onInspect={onInspect}
      />,
    );

    expect(screen.getByRole("region", { name: "Plan progress" })).toHaveTextContent("Launch plan");
    await userEvent.click(screen.getByRole("button", { name: "Open planned task Task planned" }));
    expect(onInspect).toHaveBeenCalledWith(planned);
  });
});
