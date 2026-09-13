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

const RUN_HISTORY_CSV_COLUMNS = [
  "run_id",
  "thread_id",
  "agent_id",
  "agent_name",
  "agent_handle",
  "agent_harness",
  "agent_model",
  "thread_name",
  "status",
  "attempt",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "total_tokens",
  "estimated_cost_usd",
  "cost_limit_usd",
  "over_budget",
  "created_at",
  "updated_at",
] as const;

function csvCell(value: string | number | boolean | undefined): string {
  const text = value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeRunHistoryCsv(items: RunHistoryItem[]): string {
  const rows = [RUN_HISTORY_CSV_COLUMNS.join(",")];
  for (const item of items.slice(0, RUN_HISTORY_EXPORT_MAX_ROWS)) {
    const usage = item.run.usage;
    rows.push(
      [
        item.run.id,
        item.run.threadId,
        item.run.agentId,
        item.agentName,
        item.agentHandle,
        item.agentHarness,
        item.agentModel,
        item.threadName,
        item.run.status,
        item.run.attempt,
        item.run.durationMs,
        usage?.inputTokens,
        usage?.outputTokens,
        usage?.cachedInputTokens,
        usage?.totalTokens,
        item.estimatedCostUsd,
        item.costLimitUsd,
        item.overBudget,
        item.run.createdAt,
        item.run.updatedAt,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}

export function serializeRunHistoryTelemetryRow(
  item: RunHistoryItem,
  exportedAt = new Date().toISOString(),
): string {
  const usage = item.run.usage;
  return `${JSON.stringify(
    {
      format: "nexestra.run-telemetry-row",
      version: 1,
      exportedAt,
      run: {
        id: item.run.id,
        threadId: item.run.threadId,
        triggerMessageId: item.run.triggerMessageId,
        agentId: item.run.agentId,
        attempt: item.run.attempt,
        status: item.run.status,
        failureKind: item.run.failureKind,
        durationMs: item.run.durationMs,
        usage,
        createdAt: item.run.createdAt,
        updatedAt: item.run.updatedAt,
      },
      agent: {
        name: item.agentName,
        handle: item.agentHandle,
        harness: item.agentHarness,
        model: item.agentModel,
      },
      thread: { name: item.threadName, archived: item.threadArchived },
      taskTitle: item.taskTitle,
      estimatedCostUsd: item.estimatedCostUsd,
      costLimitUsd: item.costLimitUsd,
      overBudget: item.overBudget,
    },
    null,
    2,
  )}\n`;
}

export function runHistoryCsvFilename(workspaceId: string, date = new Date()): string {
  return runHistoryExportFilename(workspaceId, date).replace(/\.json$/, ".csv");
}
