import {
  type AgentView,
  PLAN_SUMMARY_EXPORT_MAX_PLANS,
  PLAN_SUMMARY_EXPORT_MAX_TASKS,
  PlanSummaryExportSchema,
  type Task,
  type WorkAssignment,
} from "../shared/contracts.js";
import type { TaskPlanSummary } from "./App.js";

export interface PlanSummaryExportInput {
  workspaceId: string;
  plans: TaskPlanSummary[];
  agents: AgentView[];
  assignments: WorkAssignment[];
}

export function serializePlanSummaryExport(
  input: PlanSummaryExportInput,
  exportedAt = new Date().toISOString(),
): string {
  const latestAssignments = new Map<string, WorkAssignment>();
  for (const assignment of input.assignments) {
    if (assignment.workspaceId !== input.workspaceId) continue;
    const previous = latestAssignments.get(assignment.taskId);
    if (!previous || assignment.updatedAt > previous.updatedAt) {
      latestAssignments.set(assignment.taskId, assignment);
    }
  }
  const agents = new Map(input.agents.map((agent) => [agent.id, agent]));
  const scopedPlans = input.plans.flatMap((plan) => {
    const tasks = plan.tasks.filter((task) => task.workspaceId === input.workspaceId);
    return tasks.length > 0 ? [{ plan, tasks }] : [];
  });
  let remainingTasks = PLAN_SUMMARY_EXPORT_MAX_TASKS;
  const plans = scopedPlans
    .slice(0, PLAN_SUMMARY_EXPORT_MAX_PLANS)
    .map(({ plan, tasks: scopedTasks }) => {
      const tasks = scopedTasks.slice(0, remainingTasks).map((task) => {
        const assignment = latestAssignments.get(task.id);
        const assignee = task.assigneeId ? agents.get(task.assigneeId) : undefined;
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          dependsOnTaskIds: task.dependsOnTaskIds ?? [],
          assignee:
            assignee?.kind === "worker"
              ? {
                  id: assignee.id,
                  name: assignee.name,
                  handle: assignee.handle,
                  harness: assignee.harness,
                  ...(assignee.model ? { model: assignee.model } : {}),
                }
              : null,
          assignmentStatus: assignment?.status ?? null,
        };
      });
      remainingTasks -= tasks.length;
      const counts = summarizeScopedPlanTasks(scopedTasks, latestAssignments);
      return {
        id: plan.id,
        title: plan.title,
        ...counts,
        tasks,
      };
    });
  const payload = PlanSummaryExportSchema.parse({
    format: "nexestra.plan-summary",
    version: 1,
    workspaceId: input.workspaceId,
    exportedAt,
    plans,
    includedTaskCount: PLAN_SUMMARY_EXPORT_MAX_TASKS - remainingTasks,
    truncated:
      scopedPlans.length > PLAN_SUMMARY_EXPORT_MAX_PLANS ||
      scopedPlans.reduce((total, entry) => total + entry.tasks.length, 0) >
        PLAN_SUMMARY_EXPORT_MAX_TASKS,
  });
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function summarizeScopedPlanTasks(
  tasks: Task[],
  assignments: Map<string, WorkAssignment>,
): Pick<
  TaskPlanSummary,
  "total" | "ready" | "dependencyBlocked" | "delegated" | "queued" | "running" | "blocked" | "done"
> {
  const counts = {
    total: 0,
    ready: 0,
    dependencyBlocked: 0,
    delegated: 0,
    queued: 0,
    running: 0,
    blocked: 0,
    done: 0,
  };
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    counts.total += 1;
    const assignment = assignments.get(task.id);
    if (task.status === "done") counts.done += 1;
    else if (task.status === "blocked") counts.blocked += 1;
    else if (assignment?.status === "queued") counts.queued += 1;
    else if (assignment?.status === "running") counts.running += 1;
    else if (assignment) counts.delegated += 1;
    else if (
      task.dependsOnTaskIds?.some((dependencyId) => tasksById.get(dependencyId)?.status !== "done")
    )
      counts.dependencyBlocked += 1;
    else counts.ready += 1;
  }
  return counts;
}

export function planSummaryExportFilename(workspaceId: string, date = new Date()): string {
  const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "workspace";
  return `nexestra-plan-summary-${safeWorkspaceId}-${date.toISOString().slice(0, 10)}.json`;
}
