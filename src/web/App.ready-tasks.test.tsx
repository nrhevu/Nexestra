// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

  it("offers an explicit Knowledge handoff without invoking an API", async () => {
    const planned = {
      ...task("todo", "planned"),
      planId: "plan-1",
      planTitle: "Launch plan",
    };
    const onSavePlan = vi.fn();
    render(
      <Taskboard
        data={{ tasks: [planned], assignments: [], agents: [] } as unknown as BootstrapData}
        onClearReadyFilter={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onThread={vi.fn()}
        onInspect={vi.fn()}
        onSavePlan={onSavePlan}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save plan as Knowledge" }));
    expect(onSavePlan).toHaveBeenCalledOnce();
    expect(onSavePlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan-1", title: "Launch plan" }),
    );
  });

  it("preloads the reviewed Knowledge dialog and uploads only after confirmation", async () => {
    const planned = {
      ...task("todo", "planned"),
      planId: "plan-1",
      planTitle: "Launch plan",
    };
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      slug: "workspace",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
    };
    const bootstrap = {
      workspaces: [workspace],
      workspace,
      agents: [],
      threads: [],
      tasks: [planned],
      knowledge: [],
      assignments: [],
      activeRuns: [],
      attention: [],
      customSurfaces: [],
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.startsWith("/api/bootstrap")) return Response.json(bootstrap);
      if (path === "/api/knowledge/documents" && init?.method === "POST")
        return Response.json({}, { status: 201 });
      return Response.json({ error: { message: "Not found" } }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/surfaces/taskboard");
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("heading", { name: "Taskboard" });
    await user.click(screen.getByRole("button", { name: "Save plan as Knowledge" }));
    const dialog = await screen.findByRole("dialog", { name: "Add knowledge" });
    expect(within(dialog).getByPlaceholderText("Architecture guide")).toHaveValue(
      "Launch plan handoff",
    );
    expect(within(dialog).getByText(/Prepared plan handoff/)).toBeVisible();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input) === "/api/knowledge/documents" && init?.method === "POST",
      ),
    ).toBe(false);

    await user.click(within(dialog).getByRole("button", { name: "Upload document" }));
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(
        ([input, init]) => String(input) === "/api/knowledge/documents" && init?.method === "POST",
      );
      expect(request).toBeDefined();
      const body = request?.[1]?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("handle")).toBe("plan-launch-plan");
      expect((body as FormData).get("file")).toBeInstanceOf(File);
    });
  });

  it("separates dependency-blocked work from ready plan tasks", () => {
    const prerequisite = {
      ...task("todo", "prerequisite"),
      planId: "plan-1",
      planTitle: "Launch plan",
    };
    const dependent = {
      ...task("todo", "dependent"),
      planId: "plan-1",
      planTitle: "Launch plan",
      dependsOnTaskIds: [prerequisite.id],
    };
    expect(summarizeTaskPlans([prerequisite, dependent], [])[0]).toMatchObject({
      total: 2,
      ready: 1,
      dependencyBlocked: 1,
    });
  });

  it("exports plan summaries through a client-side download", async () => {
    const planned = {
      ...task("todo", "planned"),
      planId: "plan-1",
      planTitle: "Launch plan",
    };
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((_blob: Blob) => "blob:plan-summary");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    try {
      render(
        <Taskboard
          data={
            {
              workspace: { id: "workspace-1" },
              tasks: [planned],
              assignments: [],
              agents: [],
            } as unknown as BootstrapData
          }
          onClearReadyFilter={vi.fn()}
          onCreate={vi.fn()}
          onMove={vi.fn()}
          onThread={vi.fn()}
          onInspect={vi.fn()}
        />,
      );

      await userEvent.click(screen.getByRole("button", { name: "Export plan summaries" }));
      expect(createObjectURL).toHaveBeenCalledOnce();
      const exported = createObjectURL.mock.calls[0]?.[0];
      expect(exported).toBeInstanceOf(Blob);
      if (!(exported instanceof Blob)) throw new Error("expected plan summary Blob");
      expect(await exported.text()).toContain("nexestra.plan-summary");
      expect(click).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    }
  });
});

describe("Taskboard prerequisites", () => {
  it("shows bounded prerequisite status and opens the selected prerequisite", async () => {
    const prerequisite = { ...task("in_progress", "prerequisite"), title: "Prepare API" };
    const done = { ...task("done", "done"), title: "Confirm schema" };
    const foreign = {
      ...task("todo", "foreign"),
      workspaceId: "other-workspace",
      title: "Do not leak this task",
    };
    const dependent = {
      ...task("todo", "dependent"),
      title: "Ship integration",
      dependsOnTaskIds: [prerequisite.id, done.id, "missing", foreign.id],
    };
    const onInspect = vi.fn();
    render(
      <Taskboard
        data={
          {
            tasks: [dependent, prerequisite, done],
            assignments: [],
            agents: [],
          } as unknown as BootstrapData
        }
        onClearReadyFilter={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onThread={vi.fn()}
        onInspect={onInspect}
      />,
    );

    expect(screen.getByText("Prepare API · In progress")).toBeVisible();
    expect(screen.getByText("Confirm schema · Done")).toBeVisible();
    expect(screen.getByText("Unavailable prerequisite")).toBeVisible();
    expect(screen.queryByText("Do not leak this task")).not.toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Open prerequisite Prepare API" }));
    expect(onInspect).toHaveBeenCalledExactlyOnceWith(prerequisite);
  });
});
