import { z } from "zod";
import { HarnessEventTypeSchema } from "../harness.js";
import {
  EntityBaseSchema,
  HarnessIdSchema,
  IdSchema,
  RunKindSchema,
  TimestampSchema,
  UsageSchema,
} from "./common.js";

export type { RunKind } from "./common.js";
export { RunKindSchema };

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** One execution of a task by one harness. */
export const RunSchema = EntityBaseSchema.extend({
  threadId: IdSchema,
  taskId: IdSchema,
  kind: RunKindSchema,
  harness: HarnessIdSchema,
  /** Harness-side session identifier (codex rollout id / opencode session id). */
  sessionRef: z.string().optional(),
  worktreePath: z.string().optional(),
  status: RunStatusSchema,
  exitCode: z.number().int().optional(),
  usage: UsageSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
});
export type Run = z.infer<typeof RunSchema>;

/**
 * Append-only event row (PLAN.md §3). `type` mirrors the `HarnessEvent`
 * discriminator; `payload` is the normalised event body.
 */
export const RunEventSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  threadId: IdSchema,
  runId: IdSchema,
  seq: z.number().int().nonnegative(),
  type: HarnessEventTypeSchema,
  payload: z.unknown(),
  createdAt: TimestampSchema,
});
export type RunEvent = z.infer<typeof RunEventSchema>;
