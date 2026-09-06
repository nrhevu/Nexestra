import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Task, WorkBriefContentSchema } from "../shared/contracts.js";
import { createApp } from "./app.js";
import type { AgentInvocation } from "./runtime.js";
import { FileStore } from "./store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const ready = {
  chatgpt: { installed: false, connected: false, message: "Offline" },
  harnesses: {
    codex: { installed: true, version: "fixture" },
    opencode: { installed: false, version: null },
  },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-brief-task-"));
  roots.push(root);
  const store = await FileStore.open({ root, workspacePath: root });
  const thread = store.listThreads()[0];
  if (!thread) throw new Error("Expected thread");
  const brief = await store.saveWorkBrief(thread.id, {
    expectedRevision: 0,
    title: "Research an audience",
    kind: "research",
    outcome: "Recommend an audience",
    deliverables: ["Recommendation memo"],
    constraints: "Use public primary sources",
    nonGoals: "No outreach",
    acceptanceCriteria: [
      { behavior: "Citations support the claims", verification: "Read each source" },
    ],
  });
  return { root, store, thread, brief };
}

describe("Tasks drafted from a saved brief", () => {
  it("retains complete source scope across brief edits, restart and Worker execution", async () => {
    const { root, store, thread, brief } = await fixture();
    const input = {
      title: brief.title,
      kind: brief.kind,
      description: brief.outcome,
      acceptanceCriteria: brief.acceptanceCriteria,
      threadId: thread.id,
      sourceBriefRevision: brief.revision,
    };
    const idle = vi.fn();
    const initial = createApp({
      store,
      runner: { runtimeStatus: async () => ready, invoke: idle },
    });
    const response = await initial.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(201);
    const task = (await response.json()) as Task;
    expect(task.sourceBrief).toEqual(brief);
    expect(idle).not.toHaveBeenCalled();
    await store.saveWorkBrief(thread.id, {
      ...WorkBriefContentSchema.parse(brief),
      expectedRevision: 1,
      constraints: "A different future scope",
    });
    const reopened = await FileStore.open({ root, workspacePath: root });
    expect(reopened.getTask(task.id)?.sourceBrief).toEqual(brief);
    const worker = await reopened.createAgent({
      kind: "worker",
      name: "Researcher",
      handle: "researcher",
      harness: "codex",
    });
    const invoke = vi.fn(async (_agent, invocation: AgentInvocation) => {
      expect(invocation.workBrief).toEqual(brief);
      const contract = await readFile(join(invocation.workingDirectory ?? "", "TASK.md"), "utf8");
      expect(contract).toContain("Use public primary sources");
      expect(contract).toContain("No outreach");
      expect(contract).not.toContain("A different future scope");
      return "Offline submission";
    });
    const app = createApp({
      store: reopened,
      runner: { runtimeStatus: async () => ready, invoke },
    });
    expect(
      (
        await app.request(`/api/tasks/${task.id}/delegate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workerHandle: worker.handle, expectedRevision: task.revision }),
        })
      ).status,
    ).toBe(202);
    await app.dispatcher.waitForIdle();
    expect(invoke).toHaveBeenCalledOnce();
    expect(reopened.listAssignments()[0]?.contract?.sourceBrief).toEqual(brief);
  });

  it("rejects stale or cross-workspace source references and never trusts a supplied snapshot", async () => {
    const { store, thread, brief } = await fixture();
    const input = { title: brief.title, threadId: thread.id, sourceBriefRevision: 1 };
    const updated = await store.saveWorkBrief(thread.id, {
      ...WorkBriefContentSchema.parse(brief),
      expectedRevision: 1,
      title: "Updated source",
    });
    await expect(store.createTask(input)).rejects.toThrow("source brief changed");
    await expect(store.createTask({ ...input, threadId: null })).rejects.toThrow(
      "source brief changed",
    );
    const other = await store.createWorkspace({ name: "Other workspace" });
    await expect(
      store.createTask({ ...input, sourceBriefRevision: 2, workspaceId: other.id }),
    ).rejects.toThrow();
    expect(store.listTasks()).toHaveLength(0);
    const task = await store.createTask({
      ...input,
      sourceBriefRevision: 2,
      sourceBrief: { ...brief, title: "Forged source" },
    });
    expect(task.sourceBrief).toEqual(updated);
  });
});
