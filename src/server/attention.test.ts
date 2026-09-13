import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, Task, WorkAssignment } from "../shared/contracts.js";
import { workspaceActivity } from "./attention.js";
import { FileStore } from "./store.js";

const earlier = "2026-09-08T00:00:00.000Z";
const later = "2026-09-08T00:00:01.000Z";

describe("workspace attention", () => {
  let store: FileStore;
  let workspaceId: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-attention-"));
    store = await FileStore.open({ root, workspacePath: root });
    const workspace = store.listWorkspaces()[0];
    if (!workspace) throw new Error("expected seeded workspace");
    workspaceId = workspace.id;
  });

  async function assignment(task: Task, override: Partial<WorkAssignment> = {}) {
    const thread = store.listThreads(task.workspaceId)[0];
    if (!thread) throw new Error("expected workspace thread");
    return store.createAssignment({
      id: crypto.randomUUID(),
      workspaceId: task.workspaceId,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: "master-run",
      workerAgentId: "worker",
      repositoryId: "repository",
      status: "failed",
      branch: "nexestra/attempt",
      worktreePath: "workspaces/attempt",
      createdAt: earlier,
      updatedAt: later,
      ...override,
    });
  }

  it("isolates workspaces and orders pending decisions before task issues using metadata only", async () => {
    const other = await store.createWorkspace({ name: "Other workspace" });
    const thread = store.listThreads(workspaceId)[0];
    const otherThread = store.listThreads(other.id)[0];
    if (!thread || !otherThread) throw new Error("expected workspace threads");
    const agent = await store.createAgent({
      workspaceId,
      kind: "worker",
      name: "Builder",
      handle: "builder",
      harness: "codex",
    });
    const task = await store.createTask({ workspaceId, title: "Review change", status: "blocked" });
    await assignment(task, {
      error: "private-error-content",
      result: "private-worker-output",
      verificationOutput: "private-verification-output",
    });
    const foreign = await store.createTask({ workspaceId: other.id, title: "Other task" });
    await assignment(foreign);
    const run: AgentRun = {
      id: "approval",
      threadId: thread.id,
      triggerMessageId: "message",
      agentId: agent.id,
      attempt: 1,
      status: "waiting_approval",
      createdAt: earlier,
      updatedAt: earlier,
    };
    const runs: AgentRun[] = [
      run,
      { ...run, id: "input-b", status: "waiting_input", updatedAt: later },
      { ...run, id: "input-a", status: "waiting_input", updatedAt: later },
      { ...run, id: "foreign", threadId: otherThread.id },
      { ...run, id: "deleted-thread", threadId: "missing-thread" },
    ];
    const transcript = vi.spyOn(store, "threadData").mockRejectedValue(new Error("No transcript"));

    const activity = workspaceActivity(store, workspaceId, runs);

    expect(activity.workspaceId).toBe(workspaceId);
    expect(activity.activeRuns.map((entry) => entry.id)).toEqual([
      "approval",
      "input-b",
      "input-a",
    ]);
    expect(activity.attention).toMatchObject([
      { id: "run:input-a", kind: "input", title: "Builder in #general" },
      { id: "run:input-b", kind: "input" },
      { id: "run:approval", kind: "approval" },
      { id: `task:${task.id}`, kind: "task_failed", taskId: task.id },
    ]);
    expect(JSON.stringify(activity)).not.toContain("private-");
    expect(transcript).not.toHaveBeenCalled();
    expect(workspaceActivity(store, other.id, runs).attention).toMatchObject([
      { id: "run:foreign", kind: "approval", threadId: otherThread.id },
      { id: `task:${foreign.id}`, kind: "task_failed", taskId: foreign.id },
    ]);
  });

  it.each(["queued", "running", "completed"] as const)(
    "uses the latest %s attempt instead of historical failures even if the old failure updated later",
    async (status) => {
      const task = await store.createTask({ title: "Retry work", status: "in_progress" });
      await assignment(task, { createdAt: earlier, updatedAt: "2026-09-08T00:00:02.000Z" });
      await assignment(task, { status, createdAt: later, updatedAt: later });

      expect(workspaceActivity(store, workspaceId, []).attention).toEqual([]);
    },
  );

  it("chooses an attempt deterministically for equal creation times and emits one item per task", async () => {
    const task = await store.createTask({ title: "Resume work", status: "blocked" });
    await assignment(task, { id: "attempt-z", status: "interrupted", updatedAt: earlier });
    await assignment(task, { id: "attempt-a", status: "failed", updatedAt: later });

    expect(workspaceActivity(store, workspaceId, []).attention).toMatchObject([
      { id: `task:${task.id}`, kind: "task_interrupted", taskId: task.id, runId: "attempt-z" },
    ]);
  });

  it("shows blocked tasks without an attempt and clears them when resumed, done, or deleted", async () => {
    const blocked = await store.createTask({ title: "Needs a decision", status: "blocked" });
    const active = await store.createTask({ title: "Retrying", status: "blocked" });
    const done = await store.createTask({ title: "Already resolved", status: "done" });
    const removed = await store.createTask({ title: "Removed task", status: "blocked" });
    await assignment(active, { status: "running" });
    await assignment(done);
    await assignment(removed);
    await store.deleteTask(removed.id);

    expect(workspaceActivity(store, workspaceId, []).attention).toEqual([
      {
        id: `task:${blocked.id}`,
        kind: "task_blocked",
        title: blocked.title,
        detail: "This task is blocked and needs your attention.",
        taskId: blocked.id,
        updatedAt: blocked.updatedAt,
      },
    ]);
    await store.updateTask(blocked.id, { status: "in_progress" });
    expect(workspaceActivity(store, workspaceId, []).attention).toEqual([]);
  });

  it("hides snoozed items and keeps dismissals hidden until the item updates", async () => {
    const task = await store.createTask({ title: "Snooze me", status: "blocked" });
    const first = workspaceActivity(store, workspaceId, []).attention;
    expect(first).toHaveLength(1);
    const item = first[0];
    if (!item) throw new Error("expected attention item");
    await store.updateAttentionState(workspaceId, item.id, {
      action: "snooze",
      durationMinutes: 60,
    });
    expect(workspaceActivity(store, workspaceId, []).attention).toEqual([]);
    await store.updateAttentionState(workspaceId, item.id, { action: "dismiss" });
    expect(workspaceActivity(store, workspaceId, []).attention).toEqual([]);
    await store.updateTask(task.id, { title: "Updated task" });
    expect(workspaceActivity(store, workspaceId, []).attention).toHaveLength(1);
  });

  it("clears one workspace attention state and records a reversible audit action", async () => {
    await store.createTask({ title: "Restore me", status: "blocked" });
    const item = workspaceActivity(store, workspaceId, []).attention[0];
    if (!item) throw new Error("expected attention item");
    await store.updateAttentionState(workspaceId, item.id, {
      action: "snooze",
      kind: item.kind,
      durationMinutes: 60,
    });
    expect(workspaceActivity(store, workspaceId, []).attention).toEqual([]);
    await store.updateAttentionState(workspaceId, item.id, { action: "clear", kind: item.kind });
    expect(workspaceActivity(store, workspaceId, []).attention).toHaveLength(1);
    expect(store.listAttentionAudit(workspaceId)[0]).toMatchObject({
      action: "clear",
      attentionId: item.id,
    });
    const other = await store.createWorkspace({ name: "Other" });
    await store.updateAttentionState(other.id, item.id, { action: "clear", kind: item.kind });
    expect(workspaceActivity(store, workspaceId, []).attention).toHaveLength(1);
    expect(store.listAttentionAudit(other.id)[0]?.workspaceId).toBe(other.id);
  });

  it("retains a bounded, workspace-isolated audit trail across restarts", async () => {
    const root = store.root;
    const other = await store.createWorkspace({ name: "Other" });
    for (let index = 0; index < 205; index += 1) {
      await store.updateAttentionState(workspaceId, `task:item-${index}`, {
        action: index % 2 === 0 ? "dismiss" : "snooze",
        kind: "task_blocked",
        ...(index % 2 === 0 ? {} : { durationMinutes: 60 }),
      });
    }
    await store.updateAttentionState(other.id, "task:foreign", {
      action: "dismiss",
      kind: "task_failed",
    });

    expect(store.listAttentionAudit(workspaceId)).toHaveLength(200);
    expect(
      store.listAttentionAudit(workspaceId).every((entry) => entry.workspaceId === workspaceId),
    ).toBe(true);
    expect(store.listAttentionAudit(other.id)).toEqual([
      expect.objectContaining({ workspaceId: other.id, attentionId: "task:foreign" }),
    ]);

    const reopened = await FileStore.open({ root, workspacePath: root });
    expect(reopened.listAttentionAudit(workspaceId)).toHaveLength(200);
    expect(JSON.stringify(reopened.listAttentionAudit(workspaceId))).not.toContain("foreign");
  });
});
