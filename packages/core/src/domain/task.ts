import { z } from "zod";
import {
  EntityBaseSchema,
  HarnessIdSchema,
  IdSchema,
  McpServerRefSchema,
  ReasoningLevelSchema,
  SandboxLevelSchema,
} from "./common.js";

/** Task lifecycle (PLAN.md §3). */
export const TaskStatusSchema = z.enum([
  "todo",
  "ready",
  "running",
  "review",
  "verifying",
  "done",
  "failed",
  "blocked",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Where a finished task stands with respect to its worktree branch (M5).
 *
 * `undefined` means "nothing to merge" — the task produced no commit, or the
 * orchestrator was configured without a merge step. A task can be `done` and
 * still carry `pending`: the work is verified, the merge is waiting on an
 * Approval of kind `merge`.
 */
export const TaskMergeStateSchema = z.enum(["pending", "merged", "conflict"]);
export type TaskMergeState = z.infer<typeof TaskMergeStateSchema>;

/** Column identifiers used by the Task Board surface. */
export const BoardColumnSchema = z.enum(["todo", "in_progress", "review", "blocked", "done"]);
export type BoardColumn = z.infer<typeof BoardColumnSchema>;

/** Map a task status onto the kanban column it renders in. */
export function boardColumnForStatus(status: TaskStatus): BoardColumn {
  switch (status) {
    case "todo":
    case "ready":
      return "todo";
    case "running":
    case "verifying":
      return "in_progress";
    case "review":
      return "review";
    case "blocked":
    case "failed":
      return "blocked";
    case "done":
      return "done";
    default:
      return "todo";
  }
}

/** Default status assigned when a card is dragged into a column. */
export function statusForBoardColumn(column: BoardColumn): TaskStatus {
  switch (column) {
    case "todo":
      return "todo";
    case "in_progress":
      return "running";
    case "review":
      return "review";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "todo";
  }
}

/** Everything needed to configure the harness for one task. */
export const HarnessConfigSchema = z.object({
  model: z.string().optional(),
  reasoning: ReasoningLevelSchema.default("medium"),
  sandbox: SandboxLevelSchema.default("workspace-write"),
  tools: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  mcpServers: z.array(McpServerRefSchema).default([]),
  /** Relative path under `<repo>/.nexestra/worktrees/`. */
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  timeoutMs: z.number().int().positive().default(900_000),
  budgetUSD: z.number().nonnegative().optional(),
});
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const TaskSchema = EntityBaseSchema.extend({
  threadId: IdSchema,
  planId: IdSchema,
  title: z.string().min(1),
  description: z.string().default(""),
  /** Ids of tasks that must reach `done` first (DAG edges). */
  dependsOn: z.array(IdSchema).default([]),
  /** Reusable Codex/OpenCode agent profile assigned to this task. */
  agentId: IdSchema.optional(),
  assignedHarness: HarnessIdSchema.optional(),
  harnessConfig: HarnessConfigSchema,
  status: TaskStatusSchema,
  attempts: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  acceptanceCriteriaIds: z.array(IdSchema).default([]),
  costUSD: z.number().nonnegative().default(0),
  /** Set by the orchestrator once the task's branch is ready to land (M5). */
  mergeState: TaskMergeStateSchema.optional(),
  /** Manual ordering inside a board column. */
  order: z.number().int().nonnegative().default(0),
});
export type Task = z.infer<typeof TaskSchema>;
