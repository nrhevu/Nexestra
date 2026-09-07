import { z } from "zod";
import {
  type Task,
  TaskContractSchema,
  type WorkAssignment,
  WorkBriefSchema,
} from "./contracts.js";

export const GoalStepInputSchema = z
  .object({
    taskId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    workerHandle: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,30}$/),
    repositoryHandle: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,47}$/)
      .optional(),
  })
  .strict();
export const CreateWorkGoalSchema = z
  .object({
    threadId: z.string().min(1),
    objective: z.string().trim().min(1).max(2000),
    steps: z.array(GoalStepInputSchema).min(1).max(10),
    attemptLimit: z.number().int().min(1).max(30),
    timeLimitMinutes: z.number().int().min(1).max(240),
  })
  .strict()
  .superRefine((goal, context) => {
    if (new Set(goal.steps.map((step) => step.taskId)).size !== goal.steps.length)
      context.addIssue({ code: "custom", message: "Each task may appear only once in a goal." });
    if (goal.attemptLimit < goal.steps.length)
      context.addIssue({ code: "custom", message: "Allow at least one attempt for each task." });
  });
export type CreateWorkGoalInput = z.infer<typeof CreateWorkGoalSchema>;
export const GoalStatusSchema = z.enum([
  "draft",
  "active",
  "waiting_review",
  "paused",
  "blocked",
  "exhausted",
  "completed",
  "cancelled",
]);
export const WorkGoalSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string(),
  threadId: z.string(),
  objective: z.string().max(2000),
  createdBy: z.object({ kind: z.enum(["user", "agent"]), id: z.string() }),
  workBrief: WorkBriefSchema.optional(),
  revision: z.number().int().positive(),
  status: GoalStatusSchema,
  steps: z
    .array(
      z.object({
        taskId: z.string(),
        contract: TaskContractSchema,
        workerAgentId: z.string(),
        repositoryId: z.string().nullable(),
      }),
    )
    .min(1)
    .max(10),
  attemptLimit: z.number().int().min(1).max(30),
  attemptsUsed: z.number().int().nonnegative(),
  timeLimitMinutes: z.number().int().min(1).max(240),
  startedAt: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  activeAssignmentId: z.string().nullable(),
  stopReason: z.string().max(1000),
  accepted: z
    .array(z.object({ taskId: z.string(), assignmentId: z.string(), reviewId: z.string() }))
    .max(10),
  events: z
    .array(z.object({ id: z.string(), at: z.string(), detail: z.string().max(1000) }))
    .max(200),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkGoal = z.infer<typeof WorkGoalSchema>;
export const ControlWorkGoalSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    action: z.enum(["start", "pause", "cancel"]),
  })
  .strict();
export const terminalGoalStatuses = new Set<WorkGoal["status"]>([
  "completed",
  "cancelled",
  "exhausted",
]);
export function goalHoldsTasks(goal: WorkGoal) {
  return goal.startedAt !== null && !terminalGoalStatuses.has(goal.status);
}

export type GoalInspection = {
  status: WorkGoal["status"];
  reason: string;
  next?: WorkGoal["steps"][number];
  assignmentId?: string;
  accepted: WorkGoal["accepted"];
};

// The maker cannot accept its work. Only a matching immutable human review advances this loop.
export function inspectGoal(
  goal: WorkGoal,
  tasks: Task[],
  assignments: WorkAssignment[],
  now = Date.now(),
): GoalInspection {
  const accepted: WorkGoal["accepted"] = [];
  if (goal.deadlineAt && now >= Date.parse(goal.deadlineAt))
    return {
      status: "exhausted",
      reason: "The goal's elapsed-time limit has been reached. Its tasks and outputs are retained.",
      accepted: goal.accepted,
    };
  for (const step of goal.steps) {
    const task = tasks.find((entry) => entry.id === step.taskId);
    if (!task || task.threadId !== goal.threadId || task.revision !== step.contract.revision)
      return {
        status: "blocked",
        reason: `Requirements changed or a task is missing: ${step.contract.title}. Create a new goal for the revised scope.`,
        accepted,
      };
  }
  for (const step of goal.steps) {
    const task = tasks.find((entry) => entry.id === step.taskId);
    const latest = assignments.filter((entry) => entry.taskId === step.taskId).at(-1);
    if (
      task?.status === "done" &&
      latest?.review?.outcome === "accepted" &&
      latest.contract?.revision === step.contract.revision
    ) {
      accepted.push({ taskId: step.taskId, assignmentId: latest.id, reviewId: latest.review.id });
      continue;
    }
    if (latest && ["queued", "running"].includes(latest.status)) {
      return latest.goalId === goal.id
        ? {
            status: "active",
            reason: `Working on ${step.contract.title}.`,
            assignmentId: latest.id,
            accepted,
          }
        : {
            status: "blocked",
            reason: `Another process is already working on ${step.contract.title}. Finish it before continuing.`,
            accepted,
          };
    }
    if (
      latest?.status === "completed" &&
      !latest.review &&
      latest.contract?.revision === step.contract.revision
    )
      return {
        status: "waiting_review",
        reason: `Review the submitted evidence for ${step.contract.title}.`,
        assignmentId: latest.id,
        accepted,
      };
    if (latest?.id === goal.activeAssignmentId && ["failed", "interrupted"].includes(latest.status))
      return {
        status: "blocked",
        reason: `${step.contract.title} stopped: ${latest.error ?? latest.status}. Fix the cause, then resume explicitly.`,
        accepted,
      };
    if (task?.status === "done")
      return {
        status: "blocked",
        reason: `${step.contract.title} was completed manually. Reopen it and obtain independent task acceptance.`,
        accepted,
      };
    if (goal.attemptsUsed >= goal.attemptLimit)
      return {
        status: "exhausted",
        reason:
          "The goal's attempt limit has been reached. Review the feedback before creating another goal.",
        accepted,
      };
    return {
      status: "active",
      reason: `Ready to start ${step.contract.title}.`,
      next: step,
      accepted,
    };
  }
  return {
    status: "completed",
    reason: "Every task in the frozen goal scope has a matching human acceptance review.",
    accepted,
  };
}

export function recordGoalEvent(goal: WorkGoal, detail: string, now = new Date().toISOString()) {
  goal.revision += 1;
  goal.updatedAt = now;
  goal.events = [
    ...goal.events,
    { id: crypto.randomUUID(), at: now, detail: detail.slice(0, 1000) },
  ].slice(-200);
}
