import { z } from "zod";
import { EntityBaseSchema, IdSchema, TimestampSchema } from "./common.js";

/**
 * How an acceptance criterion gets proven. Verification is executed by the
 * orchestrator, never trusted from a harness' final message (PLAN.md §9).
 */
export const VerificationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    command: z.string().min(1),
    /** Exit code that counts as a pass. */
    expectExitCode: z.number().int().default(0),
    expectStdoutMatch: z.string().optional(),
  }),
  z.object({
    kind: z.literal("test"),
    command: z.string().min(1),
    /** Optional narrowing to a single test file or pattern. */
    testPath: z.string().optional(),
  }),
  z.object({
    kind: z.literal("manual_review"),
    instructions: z.string().min(1),
  }),
]);
export type Verification = z.infer<typeof VerificationSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: IdSchema,
  text: z.string().min(1),
  verification: VerificationSchema,
  /** Set once the orchestrator has produced evidence. */
  satisfied: z.boolean().default(false),
  evidenceArtifactId: IdSchema.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const OpenQuestionSchema = z.object({
  id: IdSchema,
  question: z.string().min(1),
  /** Suggested answers surfaced as chips in the Chat surface. */
  options: z.array(z.string()).default([]),
  answer: z.string().optional(),
  answeredAt: TimestampSchema.optional(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const DecisionSchema = z.object({
  id: IdSchema,
  text: z.string().min(1),
  rationale: z.string().default(""),
  decidedAt: TimestampSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

export const SpecScopeSchema = z.object({
  in: z.array(z.string()).default([]),
  out: z.array(z.string()).default([]),
});
export type SpecScope = z.infer<typeof SpecScopeSchema>;

/** Versioned specification owned by a thread (PLAN.md §3). */
export const SpecSchema = EntityBaseSchema.extend({
  threadId: IdSchema,
  version: z.number().int().min(1),
  goal: z.string().min(1),
  scope: SpecScopeSchema,
  constraints: z.array(z.string()).default([]),
  expectedOutcome: z.string().default(""),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).default([]),
  openQuestions: z.array(OpenQuestionSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  /** True once the user has approved the spec (`spec_frozen`). */
  frozen: z.boolean().default(false),
});
export type Spec = z.infer<typeof SpecSchema>;
