// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentView,
  type BootstrapData,
  TaskContractSchema,
  TaskSchema,
} from "../../shared/contracts.js";
import type { WorkGoal } from "../../shared/goals.js";
import { Goals } from "./Goals.js";

const now = "2026-09-06T20:00:00Z";
const task = TaskSchema.parse({
  id: "task",
  workspaceId: "workspace",
  threadId: "thread",
  title: "Draft a memo",
  kind: "document",
  description: "",
  status: "todo",
  assigneeId: null,
  acceptanceCriteria: [{ behavior: "Explains the decision", verification: "Read the memo" }],
  createdAt: now,
  updatedAt: now,
});
const workspace = {
  id: "workspace",
  name: "Product",
  slug: "product",
  createdAt: now,
  updatedAt: now,
};
const thread = {
  id: "thread",
  workspaceId: workspace.id,
  name: "Launch",
  slug: "launch",
  createdAt: now,
  updatedAt: now,
  messageCount: 0,
  lastMessageAt: null,
};
const worker: AgentView = {
  id: "worker",
  workspaceId: workspace.id,
  kind: "worker",
  name: "Writer",
  handle: "writer",
  description: "",
  instructions: "",
  enabled: true,
  archived: false,
  harness: "codex",
  readiness: "ready",
  readinessLabel: "Ready",
  createdAt: now,
  updatedAt: now,
};
const goal: WorkGoal = {
  id: "745bd32a-4f34-49b2-92a1-b8cb0d0f8409",
  workspaceId: workspace.id,
  threadId: thread.id,
  objective: "Explain our launch choice",
  createdBy: { kind: "user", id: "local-user" },
  steps: [
    {
      taskId: task.id,
      contract: TaskContractSchema.parse(task),
      workerAgentId: worker.id,
      repositoryId: null,
    },
  ],
  revision: 1,
  status: "draft",
  attemptsUsed: 0,
  attemptLimit: 3,
  timeLimitMinutes: 60,
  startedAt: null,
  deadlineAt: null,
  activeAssignmentId: null,
  stopReason: "Review before starting.",
  accepted: [],
  events: [{ id: "event", at: now, detail: "Goal drafted." }],
  createdAt: now,
  updatedAt: now,
};
const data: BootstrapData = {
  workspace,
  workspaces: [workspace],
  threads: [thread],
  agents: [worker],
  tasks: [task],
  knowledge: [],
  assignments: [],
  workBriefs: [],
  surfaces: [],
  goals: [],
  activeRuns: [],
  runtime: {
    chatgpt: { installed: false, connected: false, message: "offline" },
    harnesses: {
      codex: { installed: false, version: null },
      opencode: { installed: false, version: null },
    },
  },
  workspacePath: "/workspace",
  dataPath: "/workspace/.nexestra",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Goal workspace", () => {
  it("creates a draft with explicit task revisions and limits, then starts only on the user's action", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (url: string, init: RequestInit) =>
        new Response(
          JSON.stringify(
            url.endsWith("/control")
              ? {
                  ...goal,
                  revision: 2,
                  status: "waiting_review",
                  attemptsUsed: 1,
                  startedAt: now,
                  stopReason: "Review the result.",
                }
              : { ...goal, ...JSON.parse(String(init.body)), steps: goal.steps },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <Goals
        data={data}
        onChanged={async () => undefined}
        onTask={() => undefined}
        onThread={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "New goal" }));
    await user.type(screen.getByLabelText("Goal outcome"), "Explain our launch choice");
    await user.click(screen.getByRole("button", { name: /Draft a memo document/ }));
    await user.clear(screen.getByLabelText("Maximum attempts"));
    await user.type(screen.getByLabelText("Maximum attempts"), "3");
    await user.click(screen.getByRole("button", { name: "Create draft goal" }));
    await screen.findByRole("button", { name: "Start goal" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1].body))).toEqual({
      threadId: thread.id,
      objective: goal.objective,
      steps: [{ taskId: task.id, expectedRevision: 1, workerHandle: "writer" }],
      attemptLimit: 3,
      timeLimitMinutes: 60,
    });
    await user.click(screen.getByRole("button", { name: "Start goal" }));
    await screen.findByRole("button", { name: "Pause goal" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1].body))).toEqual({
      action: "start",
      expectedRevision: 1,
    });
    expect(screen.getByText("Needs your review")).toBeInTheDocument();
  });

  it("shows a stale checkpoint conflict and never invents a successful start", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "This goal changed. Reload its current checkpoint." },
            }),
            { status: 409 },
          ),
      ),
    );
    const reload = vi.fn(async () => undefined);
    render(
      <Goals
        data={{ ...data, goals: [goal] }}
        onChanged={reload}
        onTask={() => undefined}
        onThread={() => undefined}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This goal changed");
    expect(screen.getByRole("button", { name: "Start goal" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Pause goal" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload checkpoint" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
  });

  it("keeps completed goal evidence visible without offering resume or cancel", () => {
    render(
      <Goals
        data={{
          ...data,
          goals: [
            {
              ...goal,
              status: "completed",
              accepted: [{ taskId: task.id, assignmentId: "assignment", reviewId: "review" }],
            },
          ],
        }}
        onChanged={async () => undefined}
        onTask={() => undefined}
        onThread={() => undefined}
      />,
    );
    expect(screen.getByText("Accepted", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inspect task" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Resume goal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel goal" })).not.toBeInTheDocument();
  });
});
