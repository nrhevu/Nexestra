import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NexestraEvent } from "@nexestra/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, type NexestraStore, NotFoundError } from "./store.js";

let home: string;
let store: NexestraStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nexestra-test-"));
  store = createStore({ path: join(home, "nexestra.db"), dataDir: join(home, "data") });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const workspace = store.createWorkspace({ name: "demo", rootPath: "/tmp/demo" });
  const thread = store.createThread({ workspaceId: workspace.id, title: "First thread" });
  return { workspace, thread };
}

describe("migrations", () => {
  it("creates the schema on a fresh file and is a no-op on reopen", () => {
    const file = join(home, "reopen.db");
    const first = createStore({ path: file });
    first.createWorkspace({ name: "demo", rootPath: "/tmp/demo" });
    first.close();

    const second = createStore({ path: file });
    expect(second.listWorkspaces()).toHaveLength(1);
    second.close();
  });
});

describe("commands append events", () => {
  it("records a workspace-level event for a new workspace", () => {
    const workspace = store.createWorkspace({ name: "nexestra", rootPath: "/tmp/nexestra" });
    expect(workspace.shortLabel).toBe("NE");

    const events = store.events.readWorkspace(workspace.id);
    expect(events.map((event) => event.type)).toEqual(["workspace.created"]);
    expect(events[0]?.seq).toBe(0);
  });

  it("persists reusable agents with workspace-level events", () => {
    const { workspace } = fixture();
    const agent = store.createAgent({
      workspaceId: workspace.id,
      name: "Planner",
      harness: "nexestra",
      providerId: "openai",
      model: "gpt-test",
      instructions: "Focus on architecture.",
    });

    expect(store.getAgent(agent.id)).toEqual(agent);
    expect(store.listAgents(workspace.id)).toEqual([agent]);
    expect(store.events.readWorkspace(workspace.id).map((event) => event.type)).toContain(
      "agent.created",
    );

    expect(store.updateAgent(agent.id, { name: "Lead planner" }).name).toBe("Lead planner");
    store.deleteAgent(agent.id);
    expect(store.getAgent(agent.id)).toBeNull();
  });

  it("sequences thread events monotonically from zero", () => {
    const { thread } = fixture();
    store.addMessage({ threadId: thread.id, content: "hello" });
    store.addMessage({ threadId: thread.id, role: "master", content: "hi" });

    const events = store.events.readThread(thread.id);
    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "message.added",
      "message.added",
    ]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it("reads events after a known seq", () => {
    const { thread } = fixture();
    store.addMessage({ threadId: thread.id, content: "one" });
    store.addMessage({ threadId: thread.id, content: "two" });

    const tail = store.events.readThread(thread.id, 1);
    expect(tail.map((event) => event.seq)).toEqual([2]);
  });

  it("emits a status_changed event when a task moves column", () => {
    const { thread } = fixture();
    const task = store.createTask({ threadId: thread.id, title: "Write the adapter" });

    const moved = store.updateTaskStatus(task.id, "running");
    expect(moved.status).toBe("running");
    expect(store.getTask(task.id)?.status).toBe("running");

    const types = store.events.readThread(thread.id).map((event) => event.type);
    expect(types).toContain("task.status_changed");
    // The first task on a thread creates the implicit spec and plan it needs.
    expect(types).toContain("plan.upserted");
  });

  it("persists a reorder as one event and new order values", () => {
    const { thread } = fixture();
    const a = store.createTask({ threadId: thread.id, title: "a" });
    const b = store.createTask({ threadId: thread.id, title: "b" });

    store.reorderTasks(thread.id, [b.id, a.id]);
    expect(store.listTasks(thread.id).map((task) => task.title)).toEqual(["b", "a"]);
    expect(
      store.events.readThread(thread.id).filter((e) => e.type === "task.reordered"),
    ).toHaveLength(1);
  });

  it("resolves an approval and records who did it", () => {
    const { thread } = fixture();
    const approval = store.createApproval({
      threadId: thread.id,
      kind: "merge",
      title: "Merge worktree",
    });

    const resolved = store.resolveApproval(approval.id, { status: "approved", resolvedBy: "me" });
    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedBy).toBe("me");
    expect(store.listApprovals({ threadId: thread.id, status: "pending" })).toHaveLength(0);
  });

  it("keeps memory links in memory_links and hydrates them on read", () => {
    const { workspace, thread } = fixture();
    const goal = store.upsertMemory({
      workspaceId: workspace.id,
      threadId: thread.id,
      type: "goal",
      title: "Ship M1",
    });
    const requirement = store.upsertMemory({
      workspaceId: workspace.id,
      threadId: thread.id,
      type: "requirement",
      title: "Persist everything",
    });

    store.linkMemories(requirement.id, { targetId: goal.id, type: "derives_from" });
    expect(store.getMemory(requirement.id)?.links).toEqual([
      { type: "derives_from", targetId: goal.id, note: "" },
    ]);

    store.unlinkMemories(requirement.id, goal.id, "derives_from");
    expect(store.getMemory(requirement.id)?.links).toEqual([]);
  });

  it("stores and merges settings", () => {
    fixture();
    expect(store.getSettings().concurrency).toBe(2);
    const next = store.putSettings({ concurrency: 4 });
    expect(next.concurrency).toBe(4);
    expect(store.getSettings().defaultSandbox).toBe("workspace-write");
  });

  it("rejects commands against rows that do not exist", () => {
    expect(() => store.addMessage({ threadId: "nope", content: "x" })).toThrow(NotFoundError);
    expect(() => store.updateTask("nope", { title: "x" })).toThrow(NotFoundError);
  });
});

describe("subscriptions", () => {
  it("delivers thread events to a thread subscriber", () => {
    const { thread } = fixture();
    const seen: NexestraEvent[] = [];
    const stop = store.events.subscribe(thread.id, (event) => seen.push(event));

    store.addMessage({ threadId: thread.id, content: "hello" });
    stop();
    store.addMessage({ threadId: thread.id, content: "not delivered" });

    expect(seen.map((event) => event.type)).toEqual(["message.added"]);
  });

  it("delivers a workspace's thread events to a workspace subscriber", () => {
    const { workspace, thread } = fixture();
    const seen: string[] = [];
    store.events.subscribe(workspace.id, (event) => seen.push(event.type));

    store.addMessage({ threadId: thread.id, content: "hello" });
    store.createThread({ workspaceId: workspace.id, title: "Second" });

    expect(seen).toEqual(["message.added", "thread.created"]);
  });

  it("does not deliver events from a rolled back transaction", () => {
    const { thread } = fixture();
    const seen: string[] = [];
    store.events.subscribeAll((event) => seen.push(event.type));

    expect(() =>
      store.events.transaction(() => {
        store.addMessage({ threadId: thread.id, content: "doomed" });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(seen).toEqual([]);
    expect(store.listMessages(thread.id)).toHaveLength(0);
  });
});
