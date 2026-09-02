import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rebuildProjections } from "./replay.js";
import { seedMock } from "./seed.js";
import { createStore, type NexestraStore } from "./store.js";

let home: string;
let store: NexestraStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nexestra-replay-"));
  store = createStore({ path: join(home, "nexestra.db"), dataDir: join(home, "data") });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** Everything a thread projects, in a shape that compares cleanly. */
function snapshot(threadId: string) {
  return {
    thread: store.getThread(threadId),
    messages: store.listMessages(threadId),
    spec: store.getSpec(threadId),
    plan: store.getPlan(threadId),
    tasks: store.listTasks(threadId),
    runs: store.listRuns(threadId),
    runEvents: store.listRuns(threadId).flatMap((run) => store.listRunEvents(run.id)),
    artifacts: store.listArtifacts(threadId),
    approvals: store.listApprovals({ threadId }),
    memories: store.listMemories({ threadId }),
  };
}

describe("rebuildProjections", () => {
  it("reproduces the same state from the event log alone", () => {
    seedMock(store);
    const threadId = "th_agent_app";

    const before = snapshot(threadId);
    expect(before.tasks.length).toBeGreaterThan(0);
    expect(before.messages.length).toBeGreaterThan(0);
    expect(before.memories.length).toBeGreaterThan(0);

    const replayed = rebuildProjections(store, threadId);
    expect(replayed).toBeGreaterThan(0);

    expect(snapshot(threadId)).toEqual(before);
  });

  it("reproduces state built by ad-hoc commands, including deletes", () => {
    const workspace = store.createWorkspace({ name: "demo", rootPath: "/tmp/demo" });
    const thread = store.createThread({ workspaceId: workspace.id, title: "Replay me" });

    store.addMessage({ threadId: thread.id, content: "make me a CLI" });
    store.upsertSpec(thread.id, { goal: "A todo CLI", constraints: ["no network"] });
    const keep = store.createTask({ threadId: thread.id, title: "keep" });
    const drop = store.createTask({ threadId: thread.id, title: "drop" });
    const third = store.createTask({ threadId: thread.id, title: "third" });

    store.updateTaskStatus(keep.id, "running");
    store.updateTask(third.id, { assignedHarness: "codex", costUSD: 1.25 });
    store.deleteTask(drop.id);
    store.reorderTasks(thread.id, [third.id, keep.id]);

    const run = store.recordRun({
      threadId: thread.id,
      taskId: keep.id,
      kind: "execute",
      harness: "codex",
      status: "running",
    });
    store.appendRunEvent({ runId: run.id, type: "started", payload: { type: "started" } });
    store.appendRunEvent({
      runId: run.id,
      type: "assistant_text",
      payload: { type: "assistant_text", text: "working" },
    });
    store.recordRun({
      id: run.id,
      threadId: thread.id,
      taskId: keep.id,
      kind: "execute",
      harness: "codex",
      status: "succeeded",
      exitCode: 0,
      usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.02 },
      endedAt: new Date().toISOString(),
    });

    store.recordArtifact({
      threadId: thread.id,
      kind: "diff",
      title: "patch",
      path: "diffs/patch.diff",
      preview: "+ hello",
    });
    const approval = store.createApproval({
      threadId: thread.id,
      kind: "merge",
      title: "Merge it",
    });
    store.resolveApproval(approval.id, { status: "approved" });

    const a = store.upsertMemory({
      workspaceId: workspace.id,
      threadId: thread.id,
      type: "goal",
      title: "goal",
    });
    const b = store.upsertMemory({
      workspaceId: workspace.id,
      threadId: thread.id,
      type: "lesson",
      title: "lesson",
    });
    const gone = store.upsertMemory({
      workspaceId: workspace.id,
      threadId: thread.id,
      type: "research",
      title: "gone",
    });
    store.linkMemories(b.id, { targetId: a.id, type: "derives_from", note: "why" });
    store.deleteMemory(gone.id);

    const before = snapshot(thread.id);
    expect(before.tasks.map((task) => task.title)).toEqual(["third", "keep"]);
    expect(before.memories).toHaveLength(2);

    rebuildProjections(store, thread.id);

    expect(snapshot(thread.id)).toEqual(before);
  });

  it("recovers after the projection tables are corrupted", () => {
    seedMock(store);
    const threadId = "th_agent_app";
    const before = snapshot(threadId);

    store.deleteTask(before.tasks[0]?.id ?? "");
    store.updateThread(threadId, { title: "corrupted" });
    expect(store.getThread(threadId)?.title).toBe("corrupted");

    // The log now contains the corruption too, so a rebuild must reproduce the
    // corrupted state — which is exactly what makes the log authoritative.
    const after = snapshot(threadId);
    rebuildProjections(store, threadId);
    expect(snapshot(threadId)).toEqual(after);
    expect(snapshot(threadId).tasks.length).toBe(before.tasks.length - 1);
  });
});
