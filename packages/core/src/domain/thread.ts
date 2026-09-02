import { z } from "zod";
import { EntityBaseSchema, IdSchema, TimestampSchema } from "./common.js";

/**
 * Master runs as a state machine outside the LLM; `phase` is the state
 * (PLAN.md §3 / §4.1).
 */
export const ThreadPhaseSchema = z.enum([
  "intake",
  "clarifying",
  "spec_frozen",
  "planning",
  "executing",
  "verifying",
  "done",
  "blocked",
  "cancelled",
]);
export type ThreadPhase = z.infer<typeof ThreadPhaseSchema>;

/** Phases in which the thread is still moving forward on its own. */
export const ACTIVE_THREAD_PHASES: readonly ThreadPhase[] = [
  "intake",
  "clarifying",
  "spec_frozen",
  "planning",
  "executing",
  "verifying",
];

/** One conversation with the Master about a single idea / piece of work. */
export const ThreadSchema = EntityBaseSchema.extend({
  title: z.string().min(1),
  phase: ThreadPhaseSchema,
  summary: z.string().default(""),
  /** Current frozen spec, if any. */
  specId: IdSchema.optional(),
  /** Current plan, if any. */
  planId: IdSchema.optional(),
  budgetUSD: z.number().nonnegative().default(20),
  costUSD: z.number().nonnegative().default(0),
  lastActivityAt: TimestampSchema,
});
export type Thread = z.infer<typeof ThreadSchema>;
