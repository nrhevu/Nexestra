import { describe, expect, it } from "vitest";
import {
  AgentPricingSchema,
  CreateAgentSchema,
  classifyRunFailure,
  extractKnowledgeHandles,
  extractMentionHandles,
  handleFromName,
  ReorderWorkspacesSchema,
  RunHistoryItemSchema,
  RunHistoryMetricsSchema,
  RunHistoryRequestSchema,
  RunHistoryTelemetrySummarySchema,
  ThreadHistoryRequestSchema,
  UpdateAgentSchema,
} from "./contracts.js";

describe("AgentPricingSchema", () => {
  it("accepts an optional per-run limit and rejects unsafe values", () => {
    expect(AgentPricingSchema.safeParse({ maxRunCostUsd: 0.01 }).success).toBe(true);
    expect(AgentPricingSchema.safeParse({ maxRunCostUsd: -0.01 }).success).toBe(false);
    expect(AgentPricingSchema.safeParse({ maxRunCostUsd: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });
});

describe("extractMentionHandles", () => {
  it("deduplicates handles case-insensitively and ignores email addresses", () => {
    expect(extractMentionHandles("@Maya take a look, @codex and @maya. a@company.com")).toEqual([
      "maya",
      "codex",
    ]);
  });

  it("does not treat a one-character handle as valid", () => {
    expect(extractMentionHandles("hello @x and @xy")).toEqual(["xy"]);
  });
});

describe("classifyRunFailure", () => {
  it("returns safe categories without exposing the original error", () => {
    expect(classifyRunFailure("Agent timed out after 30 seconds.")).toBe("timeout");
    expect(classifyRunFailure("verification command exited with code 1")).toBe("verification");
    expect(classifyRunFailure("Provider returned HTTP 503")).toBe("provider");
    expect(classifyRunFailure("opaque token-like failure")).toBe("unknown");
  });
});

describe("handleFromName", () => {
  it("normalizes a stroked D to an ASCII handle", () => {
    expect(handleFromName("\u0110elta Coordinator")).toBe("delta-coordinator");
  });
});

describe("extractKnowledgeHandles", () => {
  it("deduplicates references and ignores fenced and inline code", () => {
    expect(
      extractKnowledgeHandles(
        "Use #Product-Repo with #architecture and #product-repo. `#inline-code`\n```txt\n#fenced\n```",
      ),
    ).toEqual(["product-repo", "architecture"]);
  });

  it("does not parse URL fragments or one-character handles", () => {
    expect(extractKnowledgeHandles("https://example.com/page#section and #x but #xy")).toEqual([
      "xy",
    ]);
  });
});

describe("CreateAgentSchema", () => {
  const customMaster = {
    kind: "master" as const,
    name: "Gateway",
    handle: "gateway",
    description: "",
    instructions: "",
    accessMode: "ask" as const,
    provider: {
      type: "custom" as const,
      name: "Gateway",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      protocol: "openai-chat" as const,
    },
  };

  it("allows a blank custom-provider key but rejects unsafe short keys", () => {
    expect(
      CreateAgentSchema.safeParse({
        ...customMaster,
        provider: { ...customMaster.provider, apiKey: "" },
      }).success,
    ).toBe(true);
    expect(
      CreateAgentSchema.safeParse({
        ...customMaster,
        provider: { ...customMaster.provider, apiKey: "short" },
      }).success,
    ).toBe(false);
  });
});

describe("ReorderWorkspacesSchema", () => {
  it("requires an exact list with every workspace id exactly once", () => {
    expect(
      ReorderWorkspacesSchema.safeParse({ workspaceIds: ["workspace-a", "workspace-b"] }).success,
    ).toBe(true);
    expect(
      ReorderWorkspacesSchema.safeParse({ workspaceIds: ["workspace-a", "workspace-a"] }).success,
    ).toBe(false);
    expect(ReorderWorkspacesSchema.safeParse({ workspaceIds: [] }).success).toBe(false);
  });
});

describe("UpdateAgentSchema", () => {
  it("clears Worker model fields with null and never accepts unknown or immutable keys", () => {
    const parsed = UpdateAgentSchema.safeParse({
      name: "Planner",
      model: null,
      reasoningEffort: null,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("expected success");
    expect(parsed.data).toMatchObject({ name: "Planner", model: null, reasoningEffort: null });
    expect(UpdateAgentSchema.safeParse({ name: "X", kind: "master" }).success).toBe(false);
    expect(UpdateAgentSchema.safeParse({ name: "X", workspaceId: "w" }).success).toBe(false);
  });
  it("rejects removing a credential at the same time as providing a new key", () => {
    const result = UpdateAgentSchema.safeParse({
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: "fixture-new-key",
        removeCredential: true,
      },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected conflicting credential choices to be rejected");
    expect(result.error.issues[0]?.message).toBe(
      "Choose either a new API key or Remove credential.",
    );
  });
});

describe("ThreadHistoryRequestSchema", () => {
  const base = { workspaceId: "workspace" };
  it("accepts positive safe integer at ordinals and rejects unsafe or mixed anchors", () => {
    expect(ThreadHistoryRequestSchema.safeParse({ ...base, at: 1 }).success).toBe(true);
    expect(
      ThreadHistoryRequestSchema.safeParse({ ...base, at: Number.MAX_SAFE_INTEGER }).success,
    ).toBe(true);
    for (const at of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(ThreadHistoryRequestSchema.safeParse({ ...base, at }).success).toBe(false);
    }
    expect(ThreadHistoryRequestSchema.safeParse({ ...base, at: 1, before: "m" }).success).toBe(
      false,
    );
    expect(ThreadHistoryRequestSchema.safeParse({ ...base, at: 1, after: "m" }).success).toBe(
      false,
    );
    expect(ThreadHistoryRequestSchema.safeParse({ ...base, at: 1, around: "m" }).success).toBe(
      false,
    );
    expect(ThreadHistoryRequestSchema.safeParse({ ...base, at: "7" }).success).toBe(true);
  });
});

describe("RunHistoryRequestSchema", () => {
  const base = { workspaceId: "workspace" };
  it("defaults to limit 50 and bounds it to 1..100", () => {
    expect(RunHistoryRequestSchema.parse(base).limit).toBe(50);
    expect(RunHistoryRequestSchema.safeParse({ ...base, limit: "1" }).success).toBe(true);
    expect(RunHistoryRequestSchema.safeParse({ ...base, limit: 100 }).success).toBe(true);
    for (const limit of [0, 101, 1.5, NaN]) {
      expect(RunHistoryRequestSchema.safeParse({ ...base, limit }).success).toBe(false);
    }
  });

  it("requires a nonempty workspace id and bounded filter strings", () => {
    expect(RunHistoryRequestSchema.safeParse({}).success).toBe(false);
    expect(RunHistoryRequestSchema.safeParse({ ...base, workspaceId: "  " }).success).toBe(false);
    expect(
      RunHistoryRequestSchema.safeParse({ ...base, workspaceId: "w".repeat(201) }).success,
    ).toBe(false);
    expect(RunHistoryRequestSchema.safeParse({ ...base, agentId: " " }).success).toBe(false);
    expect(RunHistoryRequestSchema.safeParse({ ...base, threadId: "t".repeat(201) }).success).toBe(
      false,
    );
  });

  it("rejects unknown statuses and unbounded cursors", () => {
    expect(RunHistoryRequestSchema.safeParse({ ...base, status: "finished" }).success).toBe(false);
    expect(RunHistoryRequestSchema.safeParse({ ...base, cost: "cheap" }).success).toBe(false);
    expect(RunHistoryRequestSchema.safeParse({ ...base, cursor: "" }).success).toBe(false);
    expect(RunHistoryRequestSchema.safeParse({ ...base, cursor: "a".repeat(2_049) }).success).toBe(
      false,
    );
    expect(RunHistoryRequestSchema.safeParse({ ...base, cursor: "a".repeat(2_048) }).success).toBe(
      true,
    );
  });
});

describe("RunHistoryItemSchema", () => {
  const item = {
    run: {
      id: "run-1",
      threadId: "thread-1",
      triggerMessageId: "message-1",
      agentId: "agent-1",
      attempt: 1,
      status: "completed" as const,
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:01.000Z",
    },
    agentName: "Planner",
    threadName: "Planning",
    threadArchived: false,
  };

  it("accepts optional cost budget fields and rejects unsafe values", () => {
    expect(
      RunHistoryItemSchema.safeParse({
        ...item,
        estimatedCostUsd: 0.0013,
        costLimitUsd: 0.001,
        overBudget: true,
      }).success,
    ).toBe(true);
    expect(RunHistoryItemSchema.safeParse({ ...item, estimatedCostUsd: 0.0013 }).success).toBe(
      true,
    );
    expect(RunHistoryItemSchema.safeParse({ ...item, estimatedCostUsd: -0.01 }).success).toBe(
      false,
    );
    expect(RunHistoryItemSchema.safeParse({ ...item, estimatedCostUsd: Number.NaN }).success).toBe(
      false,
    );
  });

  it("accepts bounded harness labels and rejects oversized model names", () => {
    expect(
      RunHistoryItemSchema.safeParse({ ...item, agentHarness: "opencode", agentModel: "model-x" })
        .success,
    ).toBe(true);
    expect(RunHistoryItemSchema.safeParse({ ...item, agentHarness: "unknown" }).success).toBe(
      false,
    );
    expect(RunHistoryItemSchema.safeParse({ ...item, agentModel: "m".repeat(201) }).success).toBe(
      false,
    );
  });
});

describe("RunHistoryMetricsSchema", () => {
  const metrics = {
    totalRuns: 2,
    terminalRuns: 2,
    totalDurationMs: 1_000,
    usageRuns: 1,
    totalTokens: 100,
    byAgent: [],
  };

  it("accepts partial cost coverage and rejects unsafe totals", () => {
    expect(
      RunHistoryMetricsSchema.safeParse({
        ...metrics,
        estimatedCostUsd: 0.0013,
        estimatedCostRuns: 1,
      }).success,
    ).toBe(true);
    expect(RunHistoryMetricsSchema.safeParse({ ...metrics, overBudgetRuns: 1 }).success).toBe(true);
    expect(RunHistoryMetricsSchema.safeParse({ ...metrics, estimatedCostUsd: -0.01 }).success).toBe(
      false,
    );
    expect(RunHistoryMetricsSchema.safeParse({ ...metrics, estimatedCostRuns: 1.5 }).success).toBe(
      false,
    );
  });
});

describe("RunHistoryTelemetrySummarySchema", () => {
  it("accepts aggregate cost telemetry with explicit coverage", () => {
    expect(
      RunHistoryTelemetrySummarySchema.safeParse({
        workspaceId: "workspace-a",
        totalRuns: 2,
        terminalRuns: 1,
        usageRuns: 1,
        totalTokens: 100,
        estimatedCostUsd: 0.01,
        estimatedCostRuns: 1,
        overBudgetRuns: 1,
        coverage: { complete: false, unavailableThreads: 1 },
      }).success,
    ).toBe(true);
  });
});
