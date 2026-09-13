import { z } from "zod";
import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_MAX_ENTRIES,
  WorkspaceExportManifestSchema,
  WorkspaceRecoveryManifestEntrySchema,
} from "./contracts.js";

export const WORKSPACE_ARCHIVE_INSPECTION_TIMEOUT_MS = 45_000;
export const WORKSPACE_ARCHIVE_INSPECTION_CORE_TIMEOUT_MS = 30_000;
export const WORKSPACE_ARCHIVE_INSPECTION_PAGE_SIZE = 50;

export const WorkspaceArchiveInspectionProgressSchema = z.object({
  phase: z.enum(["reading", "verifying"]),
  verifiedEntries: z.number().int().nonnegative().max(WORKSPACE_EXPORT_MAX_ENTRIES),
  totalEntries: z.number().int().nonnegative().max(WORKSPACE_EXPORT_MAX_ENTRIES),
  verifiedBytes: z.number().int().nonnegative().max(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES),
  totalBytes: z.number().int().nonnegative().max(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES),
});
export type WorkspaceArchiveInspectionProgress = z.infer<
  typeof WorkspaceArchiveInspectionProgressSchema
>;

export const WorkspaceArchiveRestorePlanSchema = z.object({
  workspace: WorkspaceExportManifestSchema.shape.workspace,
  importSupported: z.boolean(),
  counts: z.object({
    threads: z.number().int().nonnegative().max(5_000),
    agents: z.number().int().nonnegative().max(5_000),
    tasks: z.number().int().nonnegative().max(5_000),
    knowledge: z.number().int().nonnegative().max(5_000),
    assignments: z.number().int().nonnegative().max(5_000),
    attentionStates: z.number().int().nonnegative().max(5_000),
    attentionAudit: z.number().int().nonnegative().max(5_000),
  }),
  pathConflicts: z.object({
    checked: z.boolean(),
    paths: z.array(z.string().min(1).max(1_024)).max(100),
  }),
  pathCategories: z.object({
    checked: z.boolean(),
    safeToCreate: z.array(z.string().min(1).max(1_024)).max(100),
    existingIdentical: z.array(z.string().min(1).max(1_024)).max(100),
    conflicts: z.array(z.string().min(1).max(1_024)).max(100),
  }),
  unsupportedEntries: z.array(z.string().min(1).max(1_024)).max(100),
  blockers: z.array(z.string().min(1).max(500)).max(8),
});
export type WorkspaceArchiveRestorePlan = z.infer<typeof WorkspaceArchiveRestorePlanSchema>;

export const WorkspaceArchiveTargetInventorySchema = z.object({
  workspaceId: z.string().min(1).max(200),
  paths: z.array(z.string().min(1).max(1_024)).max(5_000),
  entries: z.array(WorkspaceRecoveryManifestEntrySchema).max(5_000).optional(),
});
export type WorkspaceArchiveTargetInventory = z.infer<typeof WorkspaceArchiveTargetInventorySchema>;

export const WorkspaceArchiveInspectionReportSchema = z.object({
  manifest: WorkspaceExportManifestSchema,
  archiveBytes: z.number().int().positive().max(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES),
  payloadBytes: z.number().int().nonnegative().max(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES),
  workspaceMatch: z
    .object({
      id: z.boolean(),
      name: z.boolean(),
    })
    .optional(),
  restorePlan: WorkspaceArchiveRestorePlanSchema.optional(),
});
export type WorkspaceArchiveInspectionReport = z.infer<
  typeof WorkspaceArchiveInspectionReportSchema
>;

export const WorkspaceArchiveInspectionFailureSchema = z.object({
  code: z.enum(["invalid", "unsupported", "limit", "cancelled"]),
  message: z.string().min(1).max(500),
  path: z.string().min(1).max(1_024).optional(),
});
export type WorkspaceArchiveInspectionFailure = z.infer<
  typeof WorkspaceArchiveInspectionFailureSchema
>;

export interface WorkspaceArchiveInspectionRequest {
  type: "inspect";
  requestId: number;
  file: File;
  expectedWorkspace?: {
    id: string;
    name: string;
  };
}

export const WorkspaceArchiveInspectionReplySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    requestId: z.number().int().positive(),
    progress: WorkspaceArchiveInspectionProgressSchema,
  }),
  z.object({
    type: z.literal("result"),
    requestId: z.number().int().positive(),
    report: WorkspaceArchiveInspectionReportSchema,
  }),
  z.object({
    type: z.literal("error"),
    requestId: z.number().int().positive(),
    error: WorkspaceArchiveInspectionFailureSchema,
  }),
]);
export type WorkspaceArchiveInspectionReply = z.infer<typeof WorkspaceArchiveInspectionReplySchema>;
