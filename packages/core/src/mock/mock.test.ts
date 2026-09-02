import { describe, expect, it } from "vitest";
import { ApprovalSchema } from "../domain/approval.js";
import { ArtifactSchema } from "../domain/artifact.js";
import { MemorySchema } from "../domain/memory.js";
import { MessageSchema } from "../domain/message.js";
import { findPlanCycle, PlanSchema } from "../domain/plan.js";
import { RunEventSchema, RunSchema } from "../domain/run.js";
import { SpecSchema } from "../domain/spec.js";
import { boardColumnForStatus, TaskSchema } from "../domain/task.js";
import { ThreadSchema } from "../domain/thread.js";
import { WorkspaceSchema } from "../domain/workspace.js";
import { HarnessEventSchema, RunSpecSchema } from "../harness.js";
import {
  mockApprovals,
  mockArtifacts,
  mockMemories,
  mockMessages,
  mockPlans,
  mockRunEvents,
  mockRuns,
  mockSpecs,
  mockTasks,
  mockThreads,
  mockWorkspaces,
} from "./index.js";

describe("mock data parses through the domain schemas", () => {
  it("workspaces", () => {
    expect(WorkspaceSchema.array().parse(mockWorkspaces)).toHaveLength(1);
  });

  it("threads", () => {
    const threads = ThreadSchema.array().parse(mockThreads);
    expect(threads.map((thread) => thread.title)).toEqual(["Build agent app", "Research workflow"]);
  });

  it("messages", () => {
    expect(MessageSchema.array().parse(mockMessages).length).toBeGreaterThanOrEqual(7);
  });

  it("specs", () => {
    const [spec] = SpecSchema.array().parse(mockSpecs);
    expect(spec?.frozen).toBe(true);
    expect(spec?.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
  });

  it("plans", () => {
    const [plan] = PlanSchema.array().parse(mockPlans);
    expect(plan?.taskIds).toHaveLength(6);
  });

  it("tasks", () => {
    expect(TaskSchema.array().parse(mockTasks)).toHaveLength(6);
  });

  it("runs and run events", () => {
    expect(RunSchema.array().parse(mockRuns).length).toBeGreaterThan(0);
    expect(RunEventSchema.array().parse(mockRunEvents).length).toBeGreaterThan(0);
  });

  it("artifacts", () => {
    expect(ArtifactSchema.array().parse(mockArtifacts).length).toBeGreaterThan(0);
  });

  it("approvals", () => {
    const approvals = ApprovalSchema.array().parse(mockApprovals);
    expect(approvals).toHaveLength(2);
    expect(approvals.every((approval) => approval.status === "pending")).toBe(true);
  });

  it("memories", () => {
    const memories = MemorySchema.array().parse(mockMemories);
    expect(memories.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(memories.map((memory) => memory.id));
    for (const memory of memories) {
      for (const link of memory.links) {
        expect(ids.has(link.targetId)).toBe(true);
      }
    }
  });
});

describe("plan integrity", () => {
  it("has no dependency cycle", () => {
    const [plan] = mockPlans;
    expect(plan).toBeDefined();
    expect(findPlanCycle(plan!.taskIds, plan!.edges)).toEqual([]);
  });

  it("task dependsOn matches the plan edges", () => {
    const [plan] = mockPlans;
    const edges = new Set(plan!.edges.map((edge) => `${edge.from}->${edge.to}`));
    for (const task of mockTasks) {
      for (const dependency of task.dependsOn) {
        expect(edges.has(`${dependency}->${task.id}`)).toBe(true);
      }
    }
  });

  it("covers todo, in progress and done columns", () => {
    const columns = new Set(mockTasks.map((task) => boardColumnForStatus(task.status)));
    expect(columns.has("todo")).toBe(true);
    expect(columns.has("in_progress")).toBe(true);
    expect(columns.has("done")).toBe(true);
  });
});

describe("harness contract", () => {
  it("parses every HarnessEvent variant", () => {
    const events = [
      { type: "started", sessionRef: "codex/1" },
      { type: "assistant_text", text: "hello" },
      { type: "reasoning", text: "thinking" },
      { type: "tool_call", name: "shell", input: { cmd: "ls" }, callId: "c1" },
      { type: "tool_result", callId: "c1", output: "ok", ok: true },
      { type: "file_changed", path: "a.ts", kind: "add" },
      { type: "command", cmd: "pnpm test", exitCode: 0 },
      { type: "permission_request", requestId: "p1", description: "write", risk: "high" },
      { type: "usage", inputTokens: 10, outputTokens: 2, costUSD: 0.01 },
      { type: "final", message: "done" },
      { type: "error", message: "boom", retryable: true },
      { type: "ended", exitCode: 0 },
    ];
    for (const event of events) {
      expect(() => HarnessEventSchema.parse(event)).not.toThrow();
    }
  });

  it("rejects an unknown event type", () => {
    expect(HarnessEventSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("parses a RunSpec", () => {
    const spec = RunSpecSchema.parse({
      taskId: "task_codex",
      kind: "execute",
      cwd: "/repo/.nexestra/worktrees/task_codex",
      instructions: "Implement the parser.",
      sandbox: "workspace-write",
      timeoutMs: 900_000,
    });
    expect(spec.kind).toBe("execute");
  });
});
