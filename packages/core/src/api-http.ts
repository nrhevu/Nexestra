import { z } from "zod";
import { ApprovalKindSchema, ApprovalStatusSchema } from "./domain/approval.js";
import { HarnessIdSchema, IdSchema, SandboxLevelSchema } from "./domain/common.js";
import { MemoryLinkTypeSchema, MemorySourceSchema, MemoryTypeSchema } from "./domain/memory.js";
import {
  MessageAttachmentSchema,
  MessageReferenceSchema,
  MessageRoleSchema,
} from "./domain/message.js";
import { PlanEdgeSchema } from "./domain/plan.js";
import { AppSettingsSchema } from "./domain/settings.js";
import {
  AcceptanceCriterionSchema,
  DecisionSchema,
  OpenQuestionSchema,
  SpecScopeSchema,
} from "./domain/spec.js";
import { HarnessConfigSchema, TaskStatusSchema } from "./domain/task.js";
import { ThreadPhaseSchema } from "./domain/thread.js";
import { WorkspaceSettingsSchema } from "./domain/workspace.js";
import { MasterRuntimeInfoSchema } from "./master.js";

/**
 * Request bodies and the error envelope for the real REST API introduced in
 * M1. Shared so the server validates and the web app types against exactly the
 * same shapes.
 */

/** Every non-2xx response from `/api/*` has this body. */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(["bad_request", "not_found", "conflict", "invalid_workspace_path", "internal"]),
    message: z.string(),
    /** Zod issues for `bad_request`, extra context otherwise. */
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// -------------------------------------------------------------- workspaces

export const CreateWorkspaceRequestSchema = z.object({
  /** Absolute path to a git repository on this machine. */
  path: z.string().min(1),
  name: z.string().min(1).optional(),
  shortLabel: z.string().min(1).max(3).optional(),
  defaultBranch: z.string().min(1).optional(),
  settings: WorkspaceSettingsSchema.partial().optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).optional(),
  shortLabel: z.string().min(1).max(3).optional(),
  defaultBranch: z.string().min(1).optional(),
  settings: WorkspaceSettingsSchema.partial().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

// ----------------------------------------------------------------- threads

export const CreateThreadRequestSchema = z.object({
  workspaceId: IdSchema,
  title: z.string().min(1),
  summary: z.string().optional(),
  phase: ThreadPhaseSchema.optional(),
  budgetUSD: z.number().nonnegative().optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

export const UpdateThreadRequestSchema = z.object({
  title: z.string().min(1).optional(),
  summary: z.string().optional(),
  phase: ThreadPhaseSchema.optional(),
  budgetUSD: z.number().nonnegative().optional(),
});
export type UpdateThreadRequest = z.infer<typeof UpdateThreadRequestSchema>;

// ---------------------------------------------------------------- messages

export const CreateMessageRequestSchema = z.object({
  role: MessageRoleSchema.default("user"),
  content: z.string().min(1),
  references: z.array(MessageReferenceSchema).optional(),
  attachments: z.array(MessageAttachmentSchema).optional(),
});
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;

// -------------------------------------------------------------------- spec

export const UpsertSpecRequestSchema = z.object({
  goal: z.string().min(1),
  scope: SpecScopeSchema.optional(),
  constraints: z.array(z.string()).optional(),
  expectedOutcome: z.string().optional(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).optional(),
  openQuestions: z.array(OpenQuestionSchema).optional(),
  decisions: z.array(DecisionSchema).optional(),
  frozen: z.boolean().optional(),
});
export type UpsertSpecRequest = z.infer<typeof UpsertSpecRequestSchema>;

// -------------------------------------------------------------------- plan

export const UpsertPlanRequestSchema = z.object({
  specId: IdSchema.optional(),
  summary: z.string().optional(),
  taskIds: z.array(IdSchema).optional(),
  edges: z.array(PlanEdgeSchema).optional(),
});
export type UpsertPlanRequest = z.infer<typeof UpsertPlanRequestSchema>;

// ------------------------------------------------------------------- tasks

export const CreateTaskRequestSchema = z.object({
  threadId: IdSchema,
  planId: IdSchema.optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  dependsOn: z.array(IdSchema).optional(),
  assignedHarness: HarnessIdSchema.optional(),
  harnessConfig: HarnessConfigSchema.partial().optional(),
  status: TaskStatusSchema.optional(),
  acceptanceCriteriaIds: z.array(IdSchema).optional(),
  order: z.number().int().nonnegative().optional(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  dependsOn: z.array(IdSchema).optional(),
  assignedHarness: HarnessIdSchema.nullable().optional(),
  harnessConfig: HarnessConfigSchema.partial().optional(),
  status: TaskStatusSchema.optional(),
  acceptanceCriteriaIds: z.array(IdSchema).optional(),
  attempts: z.number().int().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
  order: z.number().int().nonnegative().optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const UpdateTaskStatusRequestSchema = z.object({
  status: TaskStatusSchema,
  /** Position inside the destination column, when the move came from a drag. */
  order: z.number().int().nonnegative().optional(),
});
export type UpdateTaskStatusRequest = z.infer<typeof UpdateTaskStatusRequestSchema>;

export const ReorderTasksRequestSchema = z.object({
  threadId: IdSchema,
  /** Task ids in their new order; the index becomes `Task.order`. */
  taskIds: z.array(IdSchema).min(1),
});
export type ReorderTasksRequest = z.infer<typeof ReorderTasksRequestSchema>;

// --------------------------------------------------------------- approvals

export const CreateApprovalRequestSchema = z.object({
  threadId: IdSchema,
  kind: ApprovalKindSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  risk: z.enum(["low", "high"]).optional(),
  taskId: IdSchema.optional(),
  runId: IdSchema.optional(),
});
export type CreateApprovalRequest = z.infer<typeof CreateApprovalRequestSchema>;

export const ResolveApprovalRequestSchema = z.object({
  status: ApprovalStatusSchema.exclude(["pending"]),
  resolvedBy: z.string().optional(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequestSchema>;

// ---------------------------------------------------------------- memories

export const CreateMemoryRequestSchema = z.object({
  workspaceId: IdSchema,
  threadId: IdSchema.optional(),
  type: MemoryTypeSchema,
  title: z.string().min(1),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: MemorySourceSchema.optional(),
  authoredBy: z.enum(["master", "user"]).optional(),
});
export type CreateMemoryRequest = z.infer<typeof CreateMemoryRequestSchema>;

export const UpdateMemoryRequestSchema = z.object({
  type: MemoryTypeSchema.optional(),
  title: z.string().min(1).optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  source: MemorySourceSchema.optional(),
  authoredBy: z.enum(["master", "user"]).optional(),
});
export type UpdateMemoryRequest = z.infer<typeof UpdateMemoryRequestSchema>;

export const LinkMemoriesRequestSchema = z.object({
  targetId: IdSchema,
  type: MemoryLinkTypeSchema,
  note: z.string().optional(),
});
export type LinkMemoriesRequest = z.infer<typeof LinkMemoriesRequestSchema>;

// ---------------------------------------------------------------- settings

/**
 * `GET` / `PUT /api/settings`. The editable defaults plus the read-only
 * description of the Master runtime the server actually started with, so the
 * Settings surface can show which model client is live without a second call.
 */
export const AppSettingsResponseSchema = AppSettingsSchema.extend({
  master: MasterRuntimeInfoSchema,
});
export type AppSettingsResponse = z.infer<typeof AppSettingsResponseSchema>;

// ------------------------------------------------------------------- misc

/** `GET /api/artifacts/:id/content` */
export const ArtifactContentSchema = z.object({
  artifactId: IdSchema,
  path: z.string(),
  mimeType: z.string(),
  /** `file` when the bytes were read from `~/.nexestra/data`, else `preview`. */
  source: z.enum(["file", "preview"]),
  content: z.string(),
});
export type ArtifactContent = z.infer<typeof ArtifactContentSchema>;

/** Sandbox levels offered by the Settings surface. */
export const SANDBOX_LEVELS = SandboxLevelSchema.options;
