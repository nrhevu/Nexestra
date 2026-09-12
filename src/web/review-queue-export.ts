import {
  REVIEW_QUEUE_EXPORT_MAX_CASES,
  ReviewQueueExportSchema,
  type ReviewQueuePage,
} from "../shared/contracts.js";

export function serializeReviewQueueExport(
  page: ReviewQueuePage,
  status: "open" | "resolved" | "all",
  exportedAt = new Date().toISOString(),
): string {
  const payload = ReviewQueueExportSchema.parse({
    format: "nexestra.review-cases",
    version: 1,
    workspaceId: page.workspaceId,
    status,
    exportedAt,
    cases: page.items.slice(0, REVIEW_QUEUE_EXPORT_MAX_CASES),
  });
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function reviewQueueExportFilename(workspaceId: string, date = new Date()): string {
  const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "workspace";
  return `nexestra-review-cases-${safeWorkspaceId}-${date.toISOString().slice(0, 10)}.json`;
}
