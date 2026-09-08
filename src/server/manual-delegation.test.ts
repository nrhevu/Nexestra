import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent, RuntimeStatus } from "../shared/contracts.js";
import { createApp } from "./app.js";
import { AgentDispatcher, ChatService } from "./dispatcher.js";
import type { AssignmentRepositoryManager } from "./repository-manager.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

const runtime: RuntimeStatus = {
  chatgpt: { installed: true, connected: true, message: "ready" },
  harnesses: {
    codex: { installed: true, version: "test" },
    opencode: { installed: true, version: "test" },
  },
};

async function setup(invoke: AgentRunner["invoke"]) {
  const root = await mkdtemp(join(tmpdir(), "nexestra-manual-delegation-"));
  const store = await FileStore.open({ root, workspacePath: root });
  const runner: AgentRunner = { runtimeStatus: async () => runtime, invoke };
  const prepareAssignment = vi.fn<AssignmentRepositoryManager["prepareAssignment"]>(
    async (_repository, location) => {
      await mkdir(location.absolutePath, { recursive: true });
    },
  );
  const repositories: AssignmentRepositoryManager = {
    assignmentLocation: (workspaceId, assignmentId) => ({
      branch: `nexestra/${assignmentId}`,
      worktreePath: `workspaces/${workspaceId}/worktrees/${assignmentId}`,
      absolutePath: join(root, "workspaces", workspaceId, "worktrees", assignmentId),
    }),
    prepareAssignment,
    cleanupAssignment: async () => {},
    deleteAssignmentBranch: async () => {},
  };
  const dispatcher = new AgentDispatcher(store, runner, repositories);
  const chat = new ChatService(store, dispatcher);
  const [thread] = store.listThreads();
  if (!thread) throw new Error("Expected seeded thread.");
  const worker = await store.createAgent({
    kind: "worker",
    name: "Builder",
    handle: "builder",
    harness: "codex",
  });
  const repository = await store.createKnowledgeRepository({
    name: "Product",
    handle: "product",
    source: "/unused/local/repo",
  });
  await store.updateKnowledgeRepository(repository.id, { status: "ready", defaultBranch: "main" });
  const task = await store.createTask({ title: "Implement feature", threadId: thread.id });
  return { root, store, runner, repositories, dispatcher, chat, thread, worker, repository, task };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  await vi.waitFor(async () => expect(await predicate()).toBe(true), {
    timeout: 2_000,
    interval: 5,
  });
}

function abortable(invocation: AgentInvocation): Promise<string> {
  return new Promise((_resolve, reject) => {
    if (invocation.signal?.aborted) reject(invocation.signal.reason);
    else
      invocation.signal?.addEventListener("abort", () => reject(invocation.signal?.reason), {
        once: true,
      });
  });
}

describe("manual Worker delegation", () => {
  it("queues behind the same Worker's chat, rejects duplicate starts, and lets another Worker proceed", async () => {
    const chatGate = deferred();
    const invocations: { agent: Agent; invocation: AgentInvocation }[] = [];
    const fixture = await setup(async (agent, invocation) => {
      invocations.push({ agent, invocation });
      if (invocation.mode !== "task") await chatGate.promise;
      else {
        const data = await fixture.store.threadData(invocation.thread.id);
        const run = data.runs.find((entry) => entry.id === invocation.runId);
        const trigger = data.messages.find((entry) => entry.id === run?.triggerMessageId);
        expect(trigger).toMatchObject({
          author: { kind: "user" },
          mentions: [{ agentId: agent.id, handle: agent.handle }],
        });
        expect(invocation.transcriptSnapshot).toContain(trigger?.content);
        expect(invocation.trigger.content).toContain("commit your changes");
      }
      return "Finished.";
    });
    const { dispatcher, chat, thread, store, task, worker, repository } = fixture;
    try {
      await chat.send(thread.id, { content: "@builder review first" });
      await waitUntil(() => invocations.length === 1);
      const first = dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
      const duplicate = dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
      await expect(duplicate).rejects.toMatchObject({ code: "conflict" });
      const queued = await first;
      expect(queued).toMatchObject({ status: "queued", branch: `nexestra/${queued.id}` });
      expect(invocations).toHaveLength(1);
      expect((await dispatcher.taskProcess(task.id)).run).toMatchObject({
        id: queued.id,
        status: "queued",
      });

      const other = await store.createAgent({
        kind: "worker",
        name: "Other",
        handle: "other",
        harness: "opencode",
      });
      const otherTask = await store.createTask({ title: "Independent work", threadId: thread.id });
      await dispatcher.delegateFromTask(otherTask.id, other.handle, repository.handle);
      await waitUntil(() => store.getTask(otherTask.id)?.status === "done");
      expect(invocations.map(({ agent }) => agent.id)).toEqual([worker.id, other.id]);
    } finally {
      chatGate.resolve();
      await dispatcher.waitForIdle();
    }
    expect(invocations.map(({ agent }) => agent.id)).toEqual([
      worker.id,
      expect.any(String),
      worker.id,
    ]);
    expect(store.getTask(task.id)?.status).toBe("done");
    expect(dispatcher.activeRuns()).toEqual([]);
  });

  it("stops a queued assignment without preparing a worktree or invoking its Worker", async () => {
    const chatGate = deferred();
    const invoke = vi.fn(async () => {
      await chatGate.promise;
      return "Chat done.";
    });
    const { dispatcher, chat, thread, task, worker, repository, repositories } =
      await setup(invoke);
    try {
      await chat.send(thread.id, { content: "@builder review" });
      await waitUntil(() => invoke.mock.calls.length === 1);
      await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
      await expect(dispatcher.stopTask(task.id)).resolves.toMatchObject({
        assignment: { status: "interrupted" },
        run: { status: "interrupted" },
      });
    } finally {
      chatGate.resolve();
      await dispatcher.waitForIdle();
    }
    expect(repositories.prepareAssignment).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("stops a retried manual assignment even when an older assignment was updated more recently", async () => {
    const fixture = await setup(async (_agent, invocation) => {
      await invocation.activityHooks?.tool({
        id: "write",
        name: "write",
        permission: "edit",
        status: "running",
        input: "{}",
      });
      return abortable(invocation);
    });
    const { dispatcher, task, worker, repository, store } = fixture;
    const first = await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    await waitUntil(async () => (await dispatcher.taskProcess(task.id)).toolCalls.length === 1);
    await dispatcher.stopTask(task.id);
    await dispatcher.waitForIdle();

    const second = await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    await waitUntil(async () => (await dispatcher.taskProcess(task.id)).toolCalls.length === 1);
    await store.updateAssignment(first.id, { error: "Historical note updated later." });
    await expect(dispatcher.stopTask(task.id)).resolves.toMatchObject({
      assignment: { id: second.id, status: "interrupted" },
      run: { status: "interrupted" },
      toolCalls: [{ status: "interrupted" }],
    });
    await dispatcher.waitForIdle();
    expect(store.getTask(task.id)).toMatchObject({ status: "todo", assigneeId: null });
    expect(store.listAssignments().every((entry) => entry.status === "interrupted")).toBe(true);
  });

  it.each(["prepare", "invoke"] as const)(
    "records a %s failure and releases the task for retry",
    async (failure) => {
      let shouldFail = true;
      const fixture = await setup(async (_agent, invocation) => {
        await invocation.activityHooks?.tool({
          id: "write",
          name: "write",
          permission: "edit",
          status: "running",
          input: "{}",
        });
        if (failure === "invoke" && shouldFail) throw new Error("Fixture Worker failed.");
        await invocation.activityHooks?.tool({
          id: "write",
          name: "write",
          permission: "edit",
          status: "completed",
          input: "{}",
        });
        return "Finished.";
      });
      const { dispatcher, task, worker, repository, repositories, store } = fixture;
      if (failure === "prepare")
        vi.mocked(repositories.prepareAssignment).mockRejectedValueOnce(
          new Error("Fixture preparation failed."),
        );
      const queued = await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
      await dispatcher.waitForIdle();
      const process = await dispatcher.taskProcess(task.id);
      expect(process).toMatchObject({
        task: { status: "todo", assigneeId: null },
        assignment: { id: queued.id, status: "failed" },
        run: { id: queued.id, status: "failed" },
      });
      if (failure === "invoke")
        expect(process.toolCalls).toEqual([expect.objectContaining({ status: "failed" })]);
      shouldFail = false;
      await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
      await dispatcher.waitForIdle();
      expect(store.getTask(task.id)?.status).toBe("done");
      expect(dispatcher.hasPendingWork(worker.id)).toBe(false);
    },
  );

  it("does not dispatch or retain a task reservation when saving the trigger fails", async () => {
    const invoke = vi.fn(async () => "Done.");
    const { dispatcher, task, worker, repository, store } = await setup(invoke);
    const save = vi
      .spyOn(store, "createUserMessage")
      .mockRejectedValueOnce(new Error("Disk full."));
    await expect(
      dispatcher.delegateFromTask(task.id, worker.handle, repository.handle),
    ).rejects.toThrow("Disk full.");
    await dispatcher.waitForIdle();
    expect(store.listAssignments()).toEqual([]);
    expect(store.getTask(task.id)?.status).toBe("todo");
    expect(invoke).not.toHaveBeenCalled();
    expect(dispatcher.hasPendingWork(worker.id)).toBe(false);
    save.mockRestore();
    await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    await dispatcher.waitForIdle();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("retries a failed Worker run as a new task assignment from the thread", async () => {
    const modes: AgentInvocation["mode"][] = [];
    const fixture = await setup(async (_agent, invocation) => {
      modes.push(invocation.mode);
      if (modes.length === 1) throw new Error("Fixture failed.");
      return "Task finished.";
    });
    const { dispatcher, task, worker, repository, store } = fixture;
    const first = await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    await dispatcher.waitForIdle();
    const next = await dispatcher.retry(first.id);
    await dispatcher.waitForIdle();
    expect(next.id).not.toBe(first.id);
    expect(modes).toEqual(["task", "task"]);
    expect(store.getTask(task.id)?.status).toBe("done");
    expect((await dispatcher.taskProcess(task.id)).assignments.map((entry) => entry.id)).toEqual([
      first.id,
      next.id,
    ]);
    await expect(dispatcher.retry(first.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a late Stop after the assignment completed while its task update is still saving", async () => {
    const { dispatcher, task, worker, repository, store } = await setup(async () => "Done.");
    const tailStarted = deferred();
    const finishTail = deferred();
    const updateTask = store.updateTask.bind(store);
    const update = vi.spyOn(store, "updateTask").mockImplementation(async (id, input) => {
      if ((input as { status?: string }).status === "done") {
        tailStarted.resolve();
        await finishTail.promise;
      }
      return updateTask(id, input);
    });
    await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    try {
      await tailStarted.promise;
      await expect(dispatcher.stopTask(task.id)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      finishTail.resolve();
      await dispatcher.waitForIdle();
      update.mockRestore();
    }
    expect(await dispatcher.taskProcess(task.id)).toMatchObject({
      assignment: { status: "completed" },
      task: { status: "done" },
      run: { status: "completed" },
    });
  });

  it("accepts an HTTP delegation before the Worker finishes and validates its handles", async () => {
    const gate = deferred();
    const fixture = await setup(async () => {
      await gate.promise;
      return "Done.";
    });
    const { store, runner, repositories, task, worker, repository } = fixture;
    const app = createApp({ store, runner, repositories });
    try {
      const invalid = await app.request(`/api/tasks/${task.id}/delegate`, {
        method: "POST",
        body: "{}",
      });
      expect(invalid.status).toBe(400);
      const response = await app.request(`/api/tasks/${task.id}/delegate`, {
        method: "POST",
        body: JSON.stringify({ workerHandle: worker.handle, repositoryHandle: repository.handle }),
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toMatchObject({ taskId: task.id, status: "queued" });
      expect(store.getTask(task.id)?.status).toBe("in_progress");
    } finally {
      gate.resolve();
      await app.dispatcher.waitForIdle();
    }
    expect(store.getTask(task.id)?.status).toBe("done");
  });
});
