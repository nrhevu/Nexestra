import { describe, expect, it } from "vitest";
import type { RunHistoryItem, RunHistoryMetrics } from "../shared/contracts.js";
import {
  runHistoryCsvFilename,
  runHistoryExportFilename,
  serializeRunHistoryCsv,
  serializeRunHistoryExport,
} from "./run-history-export.js";

const summary: RunHistoryMetrics = {
  totalRuns: 1,
  terminalRuns: 1,
  totalDurationMs: 1_200,
  usageRuns: 1,
  totalTokens: 300,
  byAgent: [],
};

const item: RunHistoryItem = {
  run: {
    id: "run-1",
    threadId: "thread-1",
    triggerMessageId: "message-1",
    agentId: "agent-1",
    attempt: 1,
    status: "completed",
    durationMs: 1_200,
    usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:01.200Z",
  },
  agentName: "Planner",
  agentHandle: "planner",
  threadName: "Planning",
  threadArchived: false,
};

describe("run history export", () => {
  it("serializes summary, filters, pagination and loaded rows in a typed envelope", () => {
    const payload = JSON.parse(
      serializeRunHistoryExport(
        {
          workspaceId: "workspace-costs",
          items: [item],
          summary,
          coverage: { complete: true, unavailableThreads: 0 },
          filters: {
            agentId: "agent-1",
            threadId: null,
            status: "completed",
            cost: "over_budget",
          },
          page: { number: 2, cursor: "opaque-cursor", nextCursor: null },
        },
        "2026-09-12T01:00:00.000Z",
      ),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      format: "nexestra.run-history",
      version: 1,
      workspaceId: "workspace-costs",
      exportedAt: "2026-09-12T01:00:00.000Z",
      filters: {
        agentId: "agent-1",
        threadId: null,
        status: "completed",
        cost: "over_budget",
      },
      page: { number: 2, cursor: "opaque-cursor", nextCursor: null },
      summary,
      items: [item],
    });
  });

  it("caps the packet and sanitizes the filename", () => {
    const expanded = Array.from({ length: 101 }, (_, index) => ({
      ...item,
      run: { ...item.run, id: `run-${index}` },
    }));
    const payload = JSON.parse(
      serializeRunHistoryExport({
        workspaceId: "workspace / costs",
        items: expanded,
        summary,
        coverage: { complete: true, unavailableThreads: 0 },
        filters: { agentId: null, threadId: null, status: null },
        page: { number: 1, cursor: null, nextCursor: "next" },
      }),
    ) as { items: unknown[] };
    expect(payload.items).toHaveLength(100);
    expect(runHistoryExportFilename("workspace / costs", new Date("2026-09-12T00:00:00Z"))).toBe(
      "nexestra-run-history-workspace-costs-2026-09-12.json",
    );
  });

  it("serializes bounded telemetry columns as escaped CSV without message text", () => {
    const csv = serializeRunHistoryCsv([
      {
        ...item,
        agentName: 'Planner, "primary"',
        threadName: "Plan\nrelease",
        agentHarness: "codex",
        agentModel: "gpt-5.6-terra",
        estimatedCostUsd: 0.12,
        costLimitUsd: 0.1,
        overBudget: true,
      },
    ]);
    expect(csv).toContain("run_id,thread_id,agent_id,agent_name");
    expect(csv).toContain('"Planner, ""primary"""');
    expect(csv).toContain('"Plan\nrelease"');
    expect(csv).toContain("gpt-5.6-terra");
    expect(csv).toContain("0.12,0.1,true");
    expect(csv).not.toContain("error");
    expect(runHistoryCsvFilename("workspace / costs", new Date("2026-09-12T00:00:00Z"))).toBe(
      "nexestra-run-history-workspace-costs-2026-09-12.csv",
    );
  });
});
