import { z } from "zod";
import { IdSchema, TimestampSchema } from "./domain/common.js";

/**
 * The append-only event catalogue (PLAN.md §3/§5). Every write that reaches a
 * projection table is accompanied by exactly one event in the same SQLite
 * transaction, so the projections can always be rebuilt from the log.
 *
 * Naming is `<entity>.<past tense>`. The payload of an entity event is the full
 * post-state of that entity, which makes replay a straight upsert and removes
 * any need for the replayer to know how a patch was applied.
 */
export const NexestraEventTypeSchema = z.enum([
  // workspace
  "workspace.created",
  "workspace.updated",
  // thread
  "thread.created",
  "thread.updated",
  "thread.phase_changed",
  // message
  "message.added",
  // spec / plan
  "spec.upserted",
  "spec.frozen",
  "plan.upserted",
  // task
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.reordered",
  "task.deleted",
  // run
  "run.recorded",
  "run.event_appended",
  // artifact
  "artifact.recorded",
  // approval
  "approval.requested",
  "approval.resolved",
  // memory
  "memory.upserted",
  "memory.deleted",
  "memory.linked",
  "memory.unlinked",
  // settings
  "settings.updated",
]);
export type NexestraEventType = z.infer<typeof NexestraEventTypeSchema>;

/**
 * One row of the `events` table. `seq` is monotonic per thread; events with no
 * `threadId` (workspace-level) are sequenced per workspace instead.
 */
export const NexestraEventSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  threadId: IdSchema.optional(),
  runId: IdSchema.optional(),
  seq: z.number().int().nonnegative(),
  type: NexestraEventTypeSchema,
  payload: z.unknown(),
  createdAt: TimestampSchema,
});
export type NexestraEvent = z.infer<typeof NexestraEventSchema>;

/** Event types that carry an entity snapshot as their payload. */
export const ENTITY_SNAPSHOT_EVENTS: readonly NexestraEventType[] = [
  "workspace.created",
  "workspace.updated",
  "thread.created",
  "thread.updated",
  "thread.phase_changed",
  "message.added",
  "spec.upserted",
  "spec.frozen",
  "plan.upserted",
  "task.created",
  "task.updated",
  "task.status_changed",
  "run.recorded",
  "artifact.recorded",
  "approval.requested",
  "approval.resolved",
  "memory.upserted",
];
