import { z } from "zod";
import { CreateWorkGoalSchema, type WorkGoal } from "../shared/goals.js";
import type { ToolDefinition } from "./harness-tool-types.js";

function summary(goal: WorkGoal) {
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    briefRevision: goal.workBrief?.revision ?? null,
    createdBy: goal.createdBy,
    status: goal.status,
    stopReason: goal.stopReason,
    attemptsUsed: goal.attemptsUsed,
    attemptLimit: goal.attemptLimit,
    deadlineAt: goal.deadlineAt,
    timeLimitMinutes: goal.timeLimitMinutes,
    activeAssignmentId: goal.activeAssignmentId,
    accepted: goal.accepted,
    steps: goal.steps.map((step) => ({
      taskId: step.taskId,
      title: step.contract.title,
      taskRevision: step.contract.revision,
      workerAgentId: step.workerAgentId,
      repositoryId: step.repositoryId,
    })),
    latestCheckpoint: goal.events.at(-1),
  };
}

export function goalTools(onDraft?: (goal: WorkGoal) => void): ToolDefinition[] {
  const readSchema = z.object({}).strict();
  const draftSchema = z
    .object({
      objective: CreateWorkGoalSchema.shape.objective,
      steps: CreateWorkGoalSchema.shape.steps,
      attemptLimit: CreateWorkGoalSchema.shape.attemptLimit,
      timeLimitMinutes: CreateWorkGoalSchema.shape.timeLimitMinutes,
    })
    .strict();
  return [
    {
      type: "function",
      name: "read_goals",
      description:
        "Read durable goal checkpoints in this thread before planning or delegating. Goals own their authorized tasks, attempt budgets and original deadlines. Do not bypass a paused goal by directly delegating its tasks; ask the user to resume or cancel it in Goals. Human acceptance controls continuation.",
      permission: "read",
      parameters: z.toJSONSchema(readSchema),
      parse: async (input) => readSchema.parse(input),
      execute: async (_input, context) => {
        if (!context.hooks?.readWorkGoals) throw new Error("Goal tools are unavailable.");
        const goals = await context.hooks.readWorkGoals();
        return JSON.stringify({
          goals: goals.slice(0, 10).map(summary),
          truncated: goals.length > 10,
        });
      },
    },
    {
      type: "function",
      name: "draft_goal",
      description:
        "Draft a bounded goal from existing tasks and Workers in this thread. Read tasks first; pin their exact revisions. This does not start any process or grant execution permission. The user reviews the scope and clicks Start goal. Prefer existing goals; do not create a replacement merely to evade a budget or stop condition.",
      permission: "todowrite",
      parameters: z.toJSONSchema(draftSchema),
      parse: async (input) => draftSchema.parse(input),
      execute: async (raw, context) => {
        if (!context.hooks?.createWorkGoal) throw new Error("Goal tools are unavailable.");
        const goal = await context.hooks.createWorkGoal(draftSchema.parse(raw));
        onDraft?.(goal);
        return JSON.stringify(summary(goal));
      },
    },
  ];
}
