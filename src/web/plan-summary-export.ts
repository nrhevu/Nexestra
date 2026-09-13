import {
  type AgentView,
  PLAN_SUMMARY_EXPORT_MAX_PLANS,
  PLAN_SUMMARY_EXPORT_MAX_TASKS,
  PlanSummaryExportSchema,
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
    const previous = latestAssignments.get(assignment.taskId);
    if (!previous || assignment.updatedAt > previous.updatedAt) {
      latestAssignments.set(assignment.taskId, assignment);
    }
  }
  const agents = new Map(input.agents.map((agent) => [agent.id, agent]));
  let remainingTasks = PLAN_SUMMARY_EXPORT_MAX_TASKS;
  const plans = input.plans.slice(0, PLAN_SUMMARY_EXPORT_MAX_PLANS).map((plan) => {
    const tasks = plan.tasks.slice(0, remainingTasks).map((task) => {
      const assignment = latestAssignments.get(task.id);
      const assignee = task.assigneeId ? agents.get(task.assigneeId) : undefined;
      return {
        id: task.id,
        title: task.title,
        status: task.status,
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
    return {
      id: plan.id,
      title: plan.title,
      total: plan.total,
      ready: plan.ready,
      delegated: plan.delegated,
      queued: plan.queued,
      running: plan.running,
      blocked: plan.blocked,
      done: plan.done,
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
      input.plans.length > PLAN_SUMMARY_EXPORT_MAX_PLANS ||
      input.plans.reduce((total, plan) => total + plan.tasks.length, 0) >
        PLAN_SUMMARY_EXPORT_MAX_TASKS,
  });
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function planSummaryExportFilename(workspaceId: string, date = new Date()): string {
  const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "workspace";
  return `nexestra-plan-summary-${safeWorkspaceId}-${date.toISOString().slice(0, 10)}.json`;
}
