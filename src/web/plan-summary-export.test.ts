import { describe, expect, it } from "vitest";
import type { AgentView, Task, WorkAssignment } from "../shared/contracts.js";
import { PlanSummaryExportSchema } from "../shared/contracts.js";
import type { TaskPlanSummary } from "./App.js";
import {
  planSummaryExportFilename,
  planSummaryMarkdownFilename,
  serializePlanSummaryExport,
  serializePlanSummaryMarkdown,
} from "./plan-summary-export.js";

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
    approval: "approved",
    total: tasks.length,
    ready: 0,
    approvalBlocked: 0,
    dependencyBlocked: 0,
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
      dependsOnTaskIds: [],
      assignee: {
        id: "agent-1",
        name: "Builder",
        handle: "builder",
        harness: "codex",
        model: "gpt-5.6-terra",
      },
      assignmentStatus: "running",
    });
    expect(parsed.plans[0]).toMatchObject({ approval: "approved", approvalBlocked: 0 });
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

  it("filters foreign workspace tasks and assignments before export", () => {
    const local = plannedTask("task-1");
    const foreign = { ...plannedTask("foreign"), workspaceId: "workspace-2" };
    const parsed = PlanSummaryExportSchema.parse(
      JSON.parse(
        serializePlanSummaryExport({
          workspaceId: "workspace-1",
          plans: [summary([local, foreign])],
          agents: [worker],
          assignments: [
            assignment,
            { ...assignment, taskId: "foreign", workspaceId: "workspace-2" },
          ],
        }),
      ),
    );
    expect(parsed.plans[0]).toMatchObject({ total: 1 });
    expect(parsed.plans[0]?.tasks.map(({ id }) => id)).toEqual(["task-1"]);
    expect(parsed.includedTaskCount).toBe(1);
  });

  it("uses a stable workspace-scoped filename", () => {
    expect(planSummaryExportFilename("workspace/unsafe", new Date("2026-09-13"))).toBe(
      "nexestra-plan-summary-workspace-unsafe-2026-09-13.json",
    );
  });

  it("creates a bounded Knowledge handoff with metadata-only task lines", () => {
    const task = {
      ...plannedTask("task-1", "agent-1"),
      title: "Review\nrelease",
      dependsOnTaskIds: ["task-0"],
    };
    const markdown = serializePlanSummaryMarkdown({
      workspaceId: "workspace-1",
      plans: [summary([task])],
      agents: [worker],
      assignments: [assignment],
    });
    expect(markdown).toContain("## Launch plan");
    expect(markdown).toContain("- Approval: approved");
    expect(markdown).toContain(
      "Review release — status: in_progress; assignee: @builder; assignment: running; depends on: `task-0`",
    );
    expect(markdown).not.toContain("private acceptance details");
    expect(markdown).not.toContain("pnpm test");
    expect(markdown).not.toContain("repository-secret");
    expect(markdown).not.toContain("/private/worktree");
  });

  it("caps Knowledge handoffs and uses a safe filename", () => {
    const plans = Array.from({ length: 201 }, (_, index) => ({
      ...summary([plannedTask(`task-${index}`)]),
      id: `plan-${index}`,
      title: `Plan ${index}`,
    }));
    const markdown = serializePlanSummaryMarkdown({
      workspaceId: "workspace-1",
      plans,
      agents: [],
      assignments: [],
    });
    expect(markdown).toContain("Additional plans or tasks were omitted");
    expect(markdown.match(/^## /gm)).toHaveLength(200);
    const firstPlan = plans[0];
    expect(firstPlan).toBeDefined();
    if (!firstPlan) throw new Error("expected first plan");
    expect(planSummaryMarkdownFilename(firstPlan)).toBe("nexestra-Plan-0-handoff.md");
  });
});
