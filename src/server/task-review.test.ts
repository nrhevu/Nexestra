import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../shared/contracts.js";
import { createApp } from "./app.js";
import { FileStore } from "./store.js";

const criteria = [
  { behavior: "Every claim is traceable", verification: "Open each cited source" },
  {
    behavior: "A recommendation is actionable",
    verification: "Compare options and inspect tradeoffs",
  },
];

describe("Independent task acceptance", () => {
  let root: string;
  let store: FileStore;
  let task: Task;
  let workerId: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nexestra-review-"));
    store = await FileStore.open({ root, workspacePath: root });
    workerId = (
      await store.createAgent({
        kind: "worker",
        name: "Researcher",
        handle: "researcher",
        harness: "codex",
      })
    ).id;
    task = await store.createTask({
      title: "Research launch audience",
      kind: "research",
      threadId: store.listThreads()[0]?.id,
      acceptanceCriteria: criteria,
    });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const start = (id = crypto.randomUUID()) =>
    store.createAssignment({
      id,
      workspaceId: task.workspaceId,
      taskId: task.id,
      threadId: task.threadId ?? "",
      masterRunId: "master-run",
      workerAgentId: workerId,
      repositoryId: "repository",
      status: "queued",
      branch: `nexestra/${id}`,
      worktreePath: `workspaces/${task.workspaceId}/worktrees/${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const review = (assignmentId: string) => ({
    assignmentId,
    expectedRevision: 1,
    outcome: "accepted",
    notes: "Inspected the memo and opened its sources.",
    evidence: criteria.map((_, criterionIndex) => ({
      criterionIndex,
      observation: `Checked source ${criterionIndex + 1} against the memo.`,
    })),
  });

  it("submits successful runs for review and requires evidence for every criterion", async () => {
    const assignment = await start();
    expect(assignment.contract).toMatchObject({
      revision: 1,
      kind: "research",
      acceptanceCriteria: criteria,
    });
    await store.updateAssignment(assignment.id, {
      status: "completed",
      result: "Trust me, all checks pass.",
    });
    expect(store.getTask(task.id)?.status).toBe("in_review");
    await expect(store.updateTask(task.id, { status: "done" })).rejects.toThrow(
      "Review the Worker result",
    );
    await expect(
      store.reviewTask(task.id, { ...review(assignment.id), evidence: [] }),
    ).rejects.toThrow("every acceptance criterion");
    await expect(
      store.reviewTask(task.id, {
        ...review(assignment.id),
        evidence: [
          { criterionIndex: 0, observation: "Checked" },
          { criterionIndex: 0, observation: "Checked twice" },
        ],
      }),
    ).rejects.toThrow("different acceptance criterion");
    await expect(store.reviewTask(task.id, review(assignment.id))).resolves.toMatchObject({
      status: "done",
    });
    const reopened = await FileStore.open({ root, workspacePath: root });
    expect(reopened.getTask(task.id)?.status).toBe("done");
    expect(reopened.listAssignments()[0]?.review).toMatchObject({
      reviewedBy: "local-user",
      expectedRevision: 1,
      evidence: review(assignment.id).evidence,
    });
    await expect(reopened.reviewTask(task.id, review(assignment.id))).rejects.toThrow(
      "already has a review",
    );
    await expect(
      reopened.updateAssignment(assignment.id, { result: "Overwritten" }),
    ).rejects.toThrow("immutable");
    expect(await readFile(store.stateFile, "utf8")).toContain("Inspected the memo");
  });

  it("atomically admits one assignment and freezes the contract during execution", async () => {
    const results = await Promise.allSettled([start(), start()]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toMatchObject([
      { reason: { code: "conflict" } },
    ]);
    await expect(store.updateTask(task.id, { title: "A different goal" })).rejects.toThrow(
      "Stop the active assignment",
    );
    await expect(store.updateTask(task.id, { status: "todo" })).rejects.toThrow(
      "Stop the active assignment",
    );
    expect(store.listAssignments()[0]?.contract?.title).toBe(task.title);
  });

  it("does not publish a queued assignment in memory when state persistence fails", async () => {
    await rm(store.stateFile);
    await mkdir(store.stateFile);
    await expect(start()).rejects.toThrow();
    expect(store.listAssignments()).toHaveLength(0);
    expect(store.getTask(task.id)?.status).toBe("todo");
  });

  it("rejects stale evidence when requirements change and permits a new attempt", async () => {
    const old = await start();
    await store.updateAssignment(old.id, { status: "completed" });
    await store.updateTask(task.id, {
      title: "Research a different audience",
      expectedRevision: 1,
    });
    expect(store.getTask(task.id)).toMatchObject({ revision: 2, status: "todo" });
    await expect(
      store.updateTask(task.id, { expectedRevision: 1, description: "Stale edit" }),
    ).rejects.toThrow("Reload the task");
    await expect(store.reviewTask(task.id, review(old.id))).rejects.toThrow("requirements changed");
    const current = await start();
    expect(current.contract?.revision).toBe(2);
    await store.updateAssignment(current.id, { status: "completed" });
    await expect(
      store.reviewTask(task.id, { ...review(old.id), expectedRevision: 2 }),
    ).rejects.toThrow("latest completed assignment");
    await expect(
      store.reviewTask(task.id, { ...review(current.id), expectedRevision: 2 }),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("allows changes requested to reopen a task while preserving the failed acceptance record", async () => {
    const first = await start();
    await store.updateAssignment(first.id, { status: "completed" });
    await store.reviewTask(task.id, {
      ...review(first.id),
      outcome: "changes_requested",
      evidence: [],
      notes: "Source 2 does not support the claim. Replace it.",
    });
    expect(store.getTask(task.id)?.status).toBe("todo");
    const next = await start();
    expect(next.id).not.toBe(first.id);
    expect(store.listAssignments().find((item) => item.id === first.id)?.review?.notes).toContain(
      "Source 2",
    );
  });

  it("keeps manual completion available but never fabricates evidence for tasks without checks", async () => {
    const manual = await store.createTask({ title: "A personal reminder" });
    await expect(store.updateTask(manual.id, { status: "done" })).resolves.toMatchObject({
      status: "done",
    });
    await store.updateTask(task.id, { acceptanceCriteria: [] });
    const assignment = await start();
    await store.updateAssignment(assignment.id, { status: "completed" });
    await expect(
      store.reviewTask(task.id, { ...review(assignment.id), expectedRevision: 2, evidence: [] }),
    ).rejects.toThrow("every acceptance criterion");
    await expect(
      store.reviewTask(task.id, {
        ...review(assignment.id),
        expectedRevision: 2,
        outcome: "changes_requested",
        evidence: [],
      }),
    ).resolves.toMatchObject({ status: "todo" });
  });

  it("exposes review through the guarded API without invoking a provider or trusting an actor field", async () => {
    const assignment = await start();
    await store.updateAssignment(assignment.id, { status: "completed" });
    const runner = {
      invoke: vi.fn(),
      runtimeStatus: async () => ({
        chatgpt: { installed: false, connected: false, message: "Offline fixture" },
        harnesses: {
          codex: { installed: false, version: null },
          opencode: { installed: false, version: null },
        },
      }),
    };
    const app = createApp({ store, runner });
    const request = (body: unknown, origin?: string) =>
      app.request(`/api/tasks/${task.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });
    expect((await request({ ...review(assignment.id), reviewedBy: "worker" })).status).toBe(400);
    expect((await request(review(assignment.id), "https://evil.example")).status).toBe(403);
    expect((await request(review(assignment.id))).status).toBe(200);
    expect(runner.invoke).not.toHaveBeenCalled();
  });
});
