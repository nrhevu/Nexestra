/**
 * Zod schemas for every Master tool input (PLAN.md §4.1).
 *
 * These are the single source of truth: the JSON Schema handed to the model is
 * derived from them (`toStrictJsonSchema`) and every `tool_use` block the model
 * produces is re-validated against them before a host callback is reached.
 *
 * Deliberately free of `.default()`: defaults change the JSON Schema's
 * `required` set in confusing ways, and a strict tool schema is clearer when
 * "optional" simply means "may be omitted". Normalisation happens in the
 * handlers instead.
 */
import {
  ApprovalKindSchema,
  HarnessIdSchema,
  MemoryLinkTypeSchema,
  MemoryTypeSchema,
  ReasoningLevelSchema,
  RunKindSchema,
  SandboxLevelSchema,
  VerificationSchema,
} from "@nexestra/core";
import { z } from "zod";

/* ------------------------------------------------------------------ intake */

export const ReadWorkspaceInputSchema = z.object({
  path: z
    .string()
    .describe("Directory relative to the workspace root. Omit for the root.")
    .optional(),
  depth: z.number().int().min(1).max(8).describe("How many directory levels to walk.").optional(),
  includeManifests: z
    .boolean()
    .describe("Also return the text of README and package manifests found on the way.")
    .optional(),
});
export type ReadWorkspaceInput = z.infer<typeof ReadWorkspaceInputSchema>;

export const SearchCodeInputSchema = z.object({
  query: z.string().min(1).describe("Literal text, or a regular expression when `regex` is true."),
  path: z.string().describe("Restrict the search to this subdirectory.").optional(),
  filePattern: z.string().describe("Glob for file names, e.g. `*.ts`.").optional(),
  regex: z.boolean().describe("Treat `query` as a regular expression.").optional(),
  maxResults: z.number().int().min(1).max(200).optional(),
});
export type SearchCodeInput = z.infer<typeof SearchCodeInputSchema>;

export const SearchMemoryInputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe("Words to match against memory titles, content and tags. Omit to list recent memory.")
    .optional(),
  types: z.array(MemoryTypeSchema).describe("Restrict results to these memory types.").optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>;

/* -------------------------------------------------------------- clarifying */

export const AskUserQuestionSchema = z.object({
  id: z.string().min(1).describe("Stable id, reused when you refer to the answer later."),
  text: z.string().min(1),
  options: z
    .array(z.string().min(1))
    .max(6)
    .describe("Suggested answers, rendered as chips. Keep them concrete.")
    .optional(),
  allowFreeText: z.boolean().describe("Defaults to true.").optional(),
});
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;

export const AskUserInputSchema = z.object({
  questions: z.array(AskUserQuestionSchema).min(1).max(6),
});
export type AskUserInput = z.infer<typeof AskUserInputSchema>;

export const SpecCriterionPatchSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).describe("One observable outcome, phrased so it can pass or fail."),
  verification: VerificationSchema.describe(
    "How the orchestrator proves it: a command, a test, or a manual review.",
  ),
});

export const SpecQuestionPatchSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).max(6).optional(),
});

export const SpecDecisionPatchSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  rationale: z.string().optional(),
});

export const SpecPatchSchema = z.object({
  goal: z.string().min(1).optional(),
  scope: z
    .object({
      in: z.array(z.string().min(1)).optional(),
      out: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  constraints: z.array(z.string().min(1)).optional(),
  expectedOutcome: z.string().optional(),
  acceptanceCriteria: z
    .array(SpecCriterionPatchSchema)
    .describe("Upserted by id; criteria you do not mention are left alone.")
    .optional(),
  removeAcceptanceCriterionIds: z.array(z.string().min(1)).optional(),
  openQuestions: z.array(SpecQuestionPatchSchema).describe("Upserted by id.").optional(),
  answeredQuestions: z
    .array(z.object({ id: z.string().min(1), answer: z.string().min(1) }))
    .describe("Record an answer you already have; the question stops blocking the spec.")
    .optional(),
  decisions: z.array(SpecDecisionPatchSchema).describe("Upserted by id.").optional(),
});
export type SpecPatch = z.infer<typeof SpecPatchSchema>;

export const UpdateSpecInputSchema = z.object({
  patch: SpecPatchSchema,
  note: z.string().describe("One line on what changed and why.").optional(),
});
export type UpdateSpecInput = z.infer<typeof UpdateSpecInputSchema>;

export const RecordMemoryInputSchema = z.object({
  type: MemoryTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  links: z
    .array(
      z.object({
        type: MemoryLinkTypeSchema,
        targetId: z.string().min(1),
        note: z.string().optional(),
      }),
    )
    .optional(),
  tags: z.array(z.string().min(1)).optional(),
});
export type RecordMemoryInput = z.infer<typeof RecordMemoryInputSchema>;

export const RequestApprovalInputSchema = z.object({
  kind: ApprovalKindSchema,
  summary: z.string().min(1).describe("One line the user can decide on without scrolling."),
  payload: z
    .object({
      detail: z.string().describe("Everything the user needs to judge the request.").optional(),
      taskId: z.string().optional(),
      runId: z.string().optional(),
      specVersion: z.number().int().optional(),
      estimatedCostUSD: z.number().optional(),
      risk: z.enum(["low", "high"]).optional(),
    })
    .optional(),
});
export type RequestApprovalInput = z.infer<typeof RequestApprovalInputSchema>;

/* ---------------------------------------------------------------- planning */

export const PlanTaskHarnessConfigSchema = z.object({
  model: z.string().optional(),
  reasoning: ReasoningLevelSchema,
  sandbox: SandboxLevelSchema,
  tools: z.array(z.string().min(1)).optional(),
  skills: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().min(30_000).max(7_200_000).optional(),
  budgetUSD: z.number().min(0).optional(),
});
export type PlanTaskHarnessConfig = z.infer<typeof PlanTaskHarnessConfigSchema>;

export const PlanTaskSchema = z.object({
  id: z.string().min(1).describe("Referenced by other tasks' `dependsOn`."),
  title: z.string().min(1),
  description: z.string().min(1).describe("What a coding harness has to do, concretely."),
  dependsOn: z.array(z.string().min(1)).describe("Ids of tasks that must be done first."),
  acceptanceCriteriaIds: z
    .array(z.string().min(1))
    .min(1)
    .describe("At least one criterion id from the frozen spec."),
  harness: HarnessIdSchema,
  harnessConfig: PlanTaskHarnessConfigSchema,
});
export type PlanTaskInput = z.infer<typeof PlanTaskSchema>;

export const ProposePlanInputSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(PlanTaskSchema).min(1).max(40),
});
export type ProposePlanInput = z.infer<typeof ProposePlanInputSchema>;

export const ReplanInputSchema = z.object({
  reason: z.string().min(1),
  addTasks: z.array(PlanTaskSchema).optional(),
  updateTasks: z
    .array(PlanTaskSchema)
    .describe("Full replacement of the task with this id.")
    .optional(),
  removeTaskIds: z.array(z.string().min(1)).optional(),
});
export type ReplanInput = z.infer<typeof ReplanInputSchema>;

/* --------------------------------------------------------------- executing */

export const DispatchTaskInputSchema = z.object({
  taskId: z.string().min(1),
  kind: RunKindSchema.optional(),
  instructions: z
    .string()
    .describe("Extra instructions appended to the task description.")
    .optional(),
  harness: HarnessIdSchema.optional(),
  harnessConfig: PlanTaskHarnessConfigSchema.partial().optional(),
});
export type DispatchTaskInput = z.infer<typeof DispatchTaskInputSchema>;

export const ReadRunEventsInputSchema = z.object({
  runId: z.string().min(1),
  sinceSeq: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  types: z.array(z.string().min(1)).describe("Filter to these HarnessEvent types.").optional(),
});
export type ReadRunEventsInput = z.infer<typeof ReadRunEventsInputSchema>;

export const ReadArtifactInputSchema = z.object({
  artifactId: z.string().min(1),
  maxBytes: z.number().int().min(256).max(500_000).optional(),
});
export type ReadArtifactInput = z.infer<typeof ReadArtifactInputSchema>;

export const ControlRunInputSchema = z.object({
  runId: z.string().min(1),
  action: z.enum(["pause", "resume", "cancel", "steer"]),
  message: z.string().describe("Required for `steer`.").optional(),
});
export type ControlRunInput = z.infer<typeof ControlRunInputSchema>;

/* --------------------------------------------------------------- verifying */

export const RunVerificationInputSchema = z.object({
  taskId: z.string().min(1),
  criterionIds: z
    .array(z.string().min(1))
    .describe("Omit to run every criterion of the task.")
    .optional(),
});
export type RunVerificationInput = z.infer<typeof RunVerificationInputSchema>;

export const MarkCriterionInputSchema = z.object({
  criterionId: z.string().min(1),
  passed: z.boolean(),
  evidenceArtifactId: z.string().min(1).describe("Required when `passed` is true.").optional(),
  note: z.string().optional(),
});
export type MarkCriterionInput = z.infer<typeof MarkCriterionInputSchema>;

/* --------------------------------------------------------------- summarise */

export const SummarizeInputSchema = z.object({
  outcome: z.enum(["progress", "done", "blocked", "cancelled"]),
  summary: z.string().min(1),
  lessons: z.array(z.string().min(1)).describe("What to do differently next time.").optional(),
});
export type SummarizeInput = z.infer<typeof SummarizeInputSchema>;
