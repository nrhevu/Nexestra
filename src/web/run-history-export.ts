import {
  RUN_HISTORY_EXPORT_MAX_ROWS,
  RunHistoryExportSchema,
  type RunHistoryItem,
  type RunHistoryMetrics,
  type RunHistoryPage,
} from "../shared/contracts.js";

export interface RunHistoryExportInput {
  workspaceId: string;
  items: RunHistoryItem[];
  summary: RunHistoryMetrics;
  coverage: RunHistoryPage["coverage"];
  filters: {
    agentId: string | null;
    threadId: string | null;
    status: RunHistoryPage["items"][number]["run"]["status"] | null;
    cost?: "all" | "over_budget";
  };
  page: {
    number: number;
    cursor: string | null;
    nextCursor: string | null;
  };
}

export function serializeRunHistoryExport(
  input: RunHistoryExportInput,
  exportedAt = new Date().toISOString(),
): string {
  const payload = RunHistoryExportSchema.parse({
    format: "nexestra.run-history",
    version: 1,
    workspaceId: input.workspaceId,
    exportedAt,
    filters: input.filters,
    page: input.page,
    summary: input.summary,
    coverage: input.coverage,
    items: input.items.slice(0, RUN_HISTORY_EXPORT_MAX_ROWS),
  });
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function runHistoryExportFilename(workspaceId: string, date = new Date()): string {
  const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "workspace";
  return `nexestra-run-history-${safeWorkspaceId}-${date.toISOString().slice(0, 10)}.json`;
}
