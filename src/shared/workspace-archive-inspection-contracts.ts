import { z } from "zod";
import {
  WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKSPACE_EXPORT_MAX_ENTRIES,
  WorkspaceExportManifestSchema,
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

export const WorkspaceArchiveInspectionReportSchema = z.object({
  manifest: WorkspaceExportManifestSchema,
  archiveBytes: z.number().int().positive().max(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES),
  payloadBytes: z.number().int().nonnegative().max(WORKSPACE_EXPORT_MAX_ARCHIVE_BYTES),
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
