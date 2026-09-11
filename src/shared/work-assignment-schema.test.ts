import { describe, expect, it } from "vitest";
import { WorkAssignmentSchema } from "./contracts.js";

describe("WorkAssignmentSchema", () => {
  const base = {
    id: "assignment-schema",
    workspaceId: "workspace-1",
    taskId: "task-1",
    threadId: "thread-1",
    masterRunId: "run-1",
    workerAgentId: "worker-1",
    repositoryId: "repository-1",
    status: "running" as const,
    branch: "nexestra/assignment-schema",
    worktreePath: "workspaces/workspace-1/worktrees/assignment-schema",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts an optional full base commit SHA", () => {
    const full = WorkAssignmentSchema.parse({ ...base, baseCommit: "a".repeat(40) });
    expect(full.baseCommit).toBe("a".repeat(40));
    expect(WorkAssignmentSchema.parse(base).baseCommit).toBeUndefined();
  });

  it("keeps non-SHA base values parseable because the reviewer enforces full SHAs", () => {
    const parsed = WorkAssignmentSchema.parse({ ...base, baseCommit: "abc123" });
    expect(parsed.baseCommit).toBe("abc123");
  });

  it("trims the recorded base commit at the schema layer", () => {
    const parsed = WorkAssignmentSchema.parse({ ...base, baseCommit: "  abc123  " });
    expect(parsed.baseCommit).toBe("abc123");
  });
});
