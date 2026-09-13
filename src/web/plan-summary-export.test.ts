import { describe, expect, it } from "vitest";
import type { AgentView, Task, WorkAssignment } from "../shared/contracts.js";
import { PlanSummaryExportSchema } from "../shared/contracts.js";
import type { TaskPlanSummary } from "./App.js";
import { planSummaryExportFilename, serializePlanSummaryExport } from "./plan-summary-export.js";

function plannedTask(id: string, assigneeId: string | null = null): Task {
  return {
    id,
    workspaceId: "workspace-1",
    title: `Task ${id}`,
    description: "private acceptance details",
    status: "in_progress",
    assigneeId,
    threadId: "thread-1",
    planId: "plan-1",
    planTitle: "Launch plan",
    verificationCommand: "pnpm test",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

function summary(tasks: Task[]): TaskPlanSummary {
  return {
    id: "plan-1",
    title: "Launch plan",
    total: tasks.length,
    ready: 0,
    delegated: tasks.length,
    queued: 0,
    running: tasks.length,
    blocked: 0,
    done: 0,
    tasks,
  };
}

const worker = {
  id: "agent-1",
  workspaceId: "workspace-1",
  kind: "worker" as const,
  name: "Builder",
  handle: "builder",
  description: "private instructions",
  instructions: "private instructions",
  enabled: true,
  archived: false,
  harness: "codex" as const,
  model: "gpt-5.6-terra",
  readiness: "ready" as const,
  readinessLabel: "Ready",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
} satisfies AgentView;

const assignment = {
  id: "assignment-1",
  workspaceId: "workspace-1",
  taskId: "task-1",
  threadId: "thread-1",
  masterRunId: "run-1",
  workerAgentId: "agent-1",
  repositoryId: "repository-secret",
  status: "running" as const,
  branch: "private-branch",
  worktreePath: "/private/worktree",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T01:00:00.000Z",
} satisfies WorkAssignment;

describe("plan summary export", () => {
  it("exports bounded handoff metadata without private task or repository fields", () => {
    const output = serializePlanSummaryExport(
      {
        workspaceId: "workspace-1",
        plans: [summary([plannedTask("task-1", "agent-1")])],
        agents: [worker],
        assignments: [assignment],
      },
      "2026-09-13T02:00:00.000Z",
    );
    const parsed = PlanSummaryExportSchema.parse(JSON.parse(output));

    expect(parsed).toMatchObject({
      format: "nexestra.plan-summary",
      version: 1,
      workspaceId: "workspace-1",
      includedTaskCount: 1,
      truncated: false,
    });
    expect(parsed.plans[0]?.tasks[0]).toEqual({
      id: "task-1",
      title: "Task task-1",
      status: "in_progress",
      assignee: {
        id: "agent-1",
        name: "Builder",
        handle: "builder",
        harness: "codex",
        model: "gpt-5.6-terra",
      },
      assignmentStatus: "running",
    });
    expect(output).not.toContain("private acceptance details");
    expect(output).not.toContain("repository-secret");
    expect(output).not.toContain("/private/worktree");
  });

  it("caps plans and tasks while preserving full plan counts", () => {
    const manyPlans = Array.from({ length: 201 }, (_, index) =>
      summary([plannedTask(`task-${index}`)]),
    );
    const parsed = PlanSummaryExportSchema.parse(
      JSON.parse(
        serializePlanSummaryExport({
          workspaceId: "workspace-1",
          plans: manyPlans,
          agents: [],
          assignments: [],
        }),
      ),
    );
    expect(parsed.plans).toHaveLength(200);
    expect(parsed.includedTaskCount).toBe(200);
    expect(parsed.truncated).toBe(true);
    expect(parsed.plans[0]?.total).toBe(1);
  });

  it("uses a stable workspace-scoped filename", () => {
    expect(planSummaryExportFilename("workspace/unsafe", new Date("2026-09-13"))).toBe(
      "nexestra-plan-summary-workspace-unsafe-2026-09-13.json",
    );
  });
});
