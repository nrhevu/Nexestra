// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootstrapData, Task, WorkAssignment } from "../shared/contracts.js";
import { App, isReadyTask, readyPlanTasks, summarizeTaskPlans, Taskboard } from "./App.js";

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
    expect(isReadyTask({ ...task("todo"), planApproval: "pending" }, [])).toBe(false);
    expect(isReadyTask({ ...task("todo"), planApproval: "rejected" }, [])).toBe(false);
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

  it("requires an explicit plan review before approval and exposes bounded plan details", async () => {
    const planned = {
      ...task("todo", "planned-approval"),
      planId: "00000000-0000-4000-8000-000000000004",
      planTitle: "Approval plan",
      planApproval: "pending" as const,
      title: "Implement review flow",
      description: "Review the planned behavior before dispatch.",
      verificationCommand: "pnpm check",
      threadId: "thread-1",
      dependsOnTaskIds: ["completed-step", "missing-step"],
    };
    const completed = {
      ...task("done", "completed-step"),
      planId: planned.planId,
      planTitle: planned.planTitle,
      planApproval: "pending" as const,
      title: "Complete prerequisite",
    };
    const foreign = {
      ...task("todo", "foreign-step"),
      workspaceId: "other-workspace",
      planId: planned.planId,
      planTitle: planned.planTitle,
      planApproval: "pending" as const,
      title: "Do not show this task",
    };
    const onApprovePlan = vi.fn();
    const onRejectPlan = vi.fn();
    const onThread = vi.fn();
    const user = userEvent.setup();
    render(
      <Taskboard
        data={
          {
            workspace: { id: "workspace-1" },
            tasks: [planned, completed, foreign],
            assignments: [],
            agents: [],
          } as unknown as BootstrapData
        }
        onClearReadyFilter={vi.fn()}
        onCreate={vi.fn()}
        onMove={vi.fn()}
        onThread={onThread}
        onInspect={vi.fn()}
        onApprovePlan={onApprovePlan}
        onRejectPlan={onRejectPlan}
      />,
    );

    expect(screen.getByText("Approval: pending")).toBeVisible();
    expect(screen.getByText(/2 approval-blocked/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve plan" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    const dialog = screen.getByRole("dialog", { name: "Review Approval plan" });
    expect(within(dialog).getByText("Review the planned behavior before dispatch.")).toBeVisible();
    expect(within(dialog).getByText("pnpm check")).toBeVisible();
    expect(within(dialog).getByText("Complete prerequisite · Done")).toBeVisible();
    expect(within(dialog).getByText("Unavailable prerequisite")).toBeVisible();
    expect(within(dialog).queryByText("Do not show this task")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Open source thread" }));
    expect(onThread).toHaveBeenCalledOnce();
    expect(onThread).toHaveBeenCalledWith("thread-1");
    await user.click(within(dialog).getByRole("button", { name: "Approve plan" }));
    expect(onApprovePlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: planned.planId, approval: "pending" }),
    );
    expect(onRejectPlan).not.toHaveBeenCalled();
  });

  it("lets a reviewed pending plan be rejected exactly once", async () => {
    const planned = {
      ...task("todo", "planned-rejection"),
      planId: "00000000-0000-4000-8000-000000000005",
      planTitle: "Rejection plan",
      planApproval: "pending" as const,
    };
    const onApprovePlan = vi.fn();
    const onRejectPlan = vi.fn();
    const user = userEvent.setup();
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
        onApprovePlan={onApprovePlan}
        onRejectPlan={onRejectPlan}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review plan" }));
    await user.click(
      within(screen.getByRole("dialog", { name: "Review Rejection plan" })).getByRole("button", {
        name: "Reject plan",
      }),
    );
    expect(onRejectPlan).toHaveBeenCalledWith(
      expect.objectContaining({ id: planned.planId, approval: "pending" }),
    );
    expect(onRejectPlan).toHaveBeenCalledOnce();
    expect(onApprovePlan).not.toHaveBeenCalled();
  });

  it("requires review before reopening a rejected plan", async () => {
    const planned = {
      ...task("todo", "planned-reopen"),
      planId: "00000000-0000-4000-8000-000000000006",
      planTitle: "Reopen plan",
      planApproval: "rejected" as const,
    };
    const onApprovePlan = vi.fn();
    const onRejectPlan = vi.fn();
    const user = userEvent.setup();
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
        onApprovePlan={onApprovePlan}
        onRejectPlan={onRejectPlan}
      />,
    );

    expect(screen.queryByRole("button", { name: "Approve plan" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review plan" }));
    const dialog = screen.getByRole("dialog", { name: "Review Reopen plan" });
    expect(within(dialog).queryByRole("button", { name: "Reject plan" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Approve plan" }));
    expect(onApprovePlan).toHaveBeenCalledOnce();
    expect(onRejectPlan).not.toHaveBeenCalled();
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

describe("approved plan dispatch", () => {
  const taskboardProps = {
    onClearReadyFilter: vi.fn(),
    onCreate: vi.fn(),
    onMove: vi.fn(async () => undefined),
    onThread: vi.fn(),
    onInspect: vi.fn(),
  };

  const worker = {
    id: "worker-1",
    kind: "worker",
    handle: "implementer",
    enabled: true,
    archived: false,
  };
  const repository = {
    id: "repository-1",
    kind: "repository",
    handle: "nexestra",
    status: "ready",
  };

  it("selects only unassigned tasks whose plan is approved and prerequisites are done", () => {
    const completed = {
      ...task("done", "completed"),
      planId: "plan-1",
      planTitle: "Launch plan",
      planApproval: "approved" as const,
    };
    const ready = {
      ...task("todo", "ready"),
      planId: "plan-1",
      planTitle: "Launch plan",
      planApproval: "approved" as const,
      dependsOnTaskIds: [completed.id],
    };
    const blocked = {
      ...task("todo", "blocked"),
      planId: "plan-1",
      planTitle: "Launch plan",
      planApproval: "approved" as const,
      dependsOnTaskIds: [ready.id],
    };
    const assigned = {
      ...task("todo", "assigned"),
      planId: "plan-1",
      planTitle: "Launch plan",
      planApproval: "approved" as const,
    };
    const tasks = [completed, ready, blocked, assigned];
    const [plan] = summarizeTaskPlans(tasks, [assignment("completed", assigned.id)]);
    if (!plan) throw new Error("expected a plan summary");

    expect(readyPlanTasks(plan, tasks, [assignment("completed", assigned.id)])).toEqual([ready]);
    expect(readyPlanTasks({ ...plan, approval: "pending" }, tasks, [])).toEqual([]);
    expect(readyPlanTasks({ ...plan, approval: "rejected" }, tasks, [])).toEqual([]);
  });

  it("confirms a worker and repository, then delegates ready tasks sequentially", async () => {
    const first = {
      ...task("todo", "first"),
      title: "Prepare release",
      planId: "plan-1",
      planTitle: "Launch plan",
      planApproval: "approved" as const,
    };
    const second = {
      ...task("todo", "second"),
      title: "Publish release",
      planId: "plan-1",
      planTitle: "Launch plan",
      planApproval: "approved" as const,
    };
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      if (String(input).endsWith("/first/delegate")) return firstResponse;
      return Promise.resolve(Response.json({ id: "assignment-2" }, { status: 202 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPlanDispatchComplete = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <Taskboard
        {...taskboardProps}
        data={
          {
            tasks: [first, second],
            assignments: [],
            agents: [worker],
            knowledge: [repository],
          } as unknown as BootstrapData
        }
        onPlanDispatchComplete={onPlanDispatchComplete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dispatch 2 ready tasks" }));
    const dialog = screen.getByRole("dialog", { name: "Dispatch Launch plan" });
    expect(within(dialog).getByRole("list", { name: "Ready plan tasks" })).toHaveTextContent(
      "Prepare releasePublish release",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Dispatch 2 tasks" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/tasks/first/delegate");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/first/delegate",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      workerHandle: "implementer",
      repositoryHandle: "nexestra",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    if (resolveFirst === undefined)
      throw new Error("expected the first delegation request to be pending");
    resolveFirst(Response.json({ id: "assignment-1" }, { status: 202 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/tasks/second/delegate");
    await waitFor(() =>
      expect(onPlanDispatchComplete).toHaveBeenCalledWith(
        expect.objectContaining({ id: "plan-1" }),
        2,
      ),
    );
  });

  it("stops at the first rejected delegation and reports the partial result", async () => {
    const planned = ["first", "second", "third"].map((id) => ({
      ...task("todo", id),
      title: `Task ${id}`,
      planId: "plan-1",
      planTitle: "Launch plan",
      planApproval: "approved" as const,
    }));
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/first/delegate"))
        return Promise.resolve(Response.json({ id: "assignment-1" }, { status: 202 }));
      return Promise.resolve(
        Response.json({ error: { message: "Task is no longer ready." } }, { status: 409 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPlanDispatchComplete = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(
      <Taskboard
        {...taskboardProps}
        data={
          {
            tasks: planned,
            assignments: [],
            agents: [worker],
            knowledge: [repository],
          } as unknown as BootstrapData
        }
        onPlanDispatchComplete={onPlanDispatchComplete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dispatch 3 ready tasks" }));
    const dialog = screen.getByRole("dialog", { name: "Dispatch Launch plan" });
    await user.click(within(dialog).getByRole("button", { name: "Dispatch 3 tasks" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/api/tasks/second/delegate");
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/third/delegate"))).toBe(
      false,
    );
    expect(await within(dialog).findByText(/Queued 1 of 3 tasks/)).toBeVisible();
    expect(onPlanDispatchComplete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "plan-1" }),
      1,
    );
    expect(within(dialog).getByRole("button", { name: "Dispatch 3 tasks" })).toBeDisabled();
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
