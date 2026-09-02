import { z } from "zod";
import { HarnessIdSchema, IdSchema, RunKindSchema, TimestampSchema } from "./domain/common.js";
import { TaskStatusSchema } from "./domain/task.js";

/**
 * The wire shapes of the execution surface (M6).
 *
 * `@nexestra/orchestrator` owns the loop and its own TypeScript contracts;
 * this file is the *serialised* subset the browser sees, so `apps/web` can
 * validate what it receives without depending on the orchestrator package.
 * The server maps `OrchestratorStatus` / `OrchestratorEvent` onto these.
 */

/** Thread-level state of the loop itself — not `Thread.phase`. */
export const ThreadRunStateSchema = z.enum(["idle", "running", "paused", "cancelled"]);
export type ThreadRunState = z.infer<typeof ThreadRunStateSchema>;

/** Why the loop stopped touching a thread. */
export const ThreadOutcomeSchema = z.enum([
  "completed",
  "failed",
  "blocked",
  "paused",
  "cancelled",
  "budget_exceeded",
]);
export type ThreadOutcome = z.infer<typeof ThreadOutcomeSchema>;

export const ActiveRunSummarySchema = z.object({
  runId: IdSchema,
  taskId: IdSchema,
  kind: RunKindSchema,
  harness: HarnessIdSchema,
  startedAt: TimestampSchema,
});
export type ActiveRunSummary = z.infer<typeof ActiveRunSummarySchema>;

/**
 * `GET /api/threads/:id/execution/status`, and the payload of the
 * `orchestrator.status_changed` event.
 */
export const ExecutionStatusSchema = z.object({
  threadId: IdSchema,
  workspaceId: IdSchema,
  state: ThreadRunStateSchema,
  /** Task counts per `TaskStatus`. */
  tasks: z.record(TaskStatusSchema, z.number().int().nonnegative()),
  totalTasks: z.number().int().nonnegative(),
  activeRuns: z.array(ActiveRunSummarySchema).default([]),
  pendingApprovals: z.number().int().nonnegative().default(0),
  costUSD: z.number().nonnegative().default(0),
  budgetUSD: z.number().nonnegative().default(0),
  /** `costUSD / budgetUSD`, or 0 when there is no budget. */
  budgetRatio: z.number().nonnegative().default(0),
  lastOutcome: ThreadOutcomeSchema.optional(),
  /** False when no orchestrator is attached (no adapter is available). */
  available: z.boolean().default(true),
});
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/**
 * One line of orchestrator progress, ready to render.
 *
 * The server flattens `OrchestratorEvent` into this before appending it, so
 * the Chat surface renders a system row without knowing the loop's union — and
 * `kind` keeps the original discriminator for anything that wants to filter.
 */
export const OrchestratorProgressSchema = z.object({
  threadId: IdSchema,
  /** The `OrchestratorEvent.type` this line was made from. */
  kind: z.string().min(1),
  level: z.enum(["info", "warn", "error"]).default("info"),
  message: z.string(),
  taskId: IdSchema.optional(),
  runId: IdSchema.optional(),
  at: TimestampSchema,
  /** The original event, for anything that wants the detail. */
  detail: z.unknown().optional(),
});
export type OrchestratorProgress = z.infer<typeof OrchestratorProgressSchema>;

/* ------------------------------------------------------------- run content */

export const FileChangeKindSchema = z.enum(["add", "modify", "delete"]);

export const RunDiffFileSchema = z.object({
  path: z.string(),
  kind: FileChangeKindSchema,
  untracked: z.boolean().default(false),
});
export type RunDiffFile = z.infer<typeof RunDiffFileSchema>;

/** `GET /api/runs/:id/diff` — the unified diff of the run's worktree. */
export const RunDiffSchema = z.object({
  runId: IdSchema,
  worktreePath: z.string(),
  /** The ref the diff was taken against. */
  base: z.string(),
  patch: z.string(),
  files: z.array(RunDiffFileSchema).default([]),
  truncated: z.boolean().default(false),
});
export type RunDiff = z.infer<typeof RunDiffSchema>;

/* --------------------------------------------------------------- requests */

/** `POST /api/threads/:id/execution/:action` */
export const ExecutionActionSchema = z.enum(["start", "pause", "resume", "cancel"]);
export type ExecutionAction = z.infer<typeof ExecutionActionSchema>;

/** `POST /api/runs/:id/control` */
export const RunControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel"), message: z.string().optional() }),
  z.object({ action: z.literal("steer"), message: z.string().min(1) }),
  z.object({
    action: z.literal("answer_permission"),
    requestId: z.string().min(1),
    approved: z.boolean(),
    note: z.string().optional(),
  }),
]);
export type RunControlRequest = z.infer<typeof RunControlRequestSchema>;

export const RunControlResponseSchema = z.object({
  runId: IdSchema,
  ok: z.boolean(),
  note: z.string().optional(),
});
export type RunControlResponse = z.infer<typeof RunControlResponseSchema>;

/** `POST /api/tasks/:id/dispatch` */
export const DispatchTaskRequestSchema = z.object({
  kind: RunKindSchema.optional(),
  harness: HarnessIdSchema.optional(),
  instructions: z.string().optional(),
});
export type DispatchTaskRequest = z.infer<typeof DispatchTaskRequestSchema>;

export const DispatchTaskResponseSchema = z.object({
  runId: IdSchema,
  taskId: IdSchema,
  harness: HarnessIdSchema,
  kind: RunKindSchema,
  worktreePath: z.string().optional(),
});
export type DispatchTaskResponse = z.infer<typeof DispatchTaskResponseSchema>;

/** `POST /api/tasks/:id/verify` */
export const VerifyTaskRequestSchema = z.object({
  criterionIds: z.array(IdSchema).optional(),
});
export type VerifyTaskRequest = z.infer<typeof VerifyTaskRequestSchema>;

export const VerificationOutcomeSchema = z.object({
  criterionId: IdSchema,
  passed: z.boolean(),
  evidenceArtifactId: IdSchema.optional(),
  exitCode: z.number().int().optional(),
  output: z.string().optional(),
});
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

export const VerifyTaskResponseSchema = z.object({
  taskId: IdSchema,
  outcomes: z.array(VerificationOutcomeSchema).default([]),
});
export type VerifyTaskResponse = z.infer<typeof VerifyTaskResponseSchema>;
