import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, RuntimeStatus, ThreadStreamEvent, ToolCall } from "../shared/contracts.js";
import { AgentDispatcher, ChatService } from "./dispatcher.js";
import type { AssignmentLocation, AssignmentRepositoryManager } from "./repository-manager.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore, StoreError } from "./store.js";

const readyRuntime: RuntimeStatus = {
  chatgpt: { installed: true, connected: true, message: "ready" },
  harnesses: {
    codex: { installed: true, version: "test" },
    opencode: { installed: true, version: "test" },
  },
};

class FakeRunner implements AgentRunner {
  readonly invocations: { agent: Agent; invocation: AgentInvocation }[] = [];

  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    this.invocations.push({ agent, invocation });
    return `reply from @${agent.handle}`;
  }
}

class ConcurrentApprovalRunner implements AgentRunner {
  readonly resolved: string[] = [];

  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    if (!invocation.toolHooks) throw new Error("expected tool hooks");
    const now = new Date().toISOString();
    const calls = ["first", "second"].map(
      (id): ToolCall => ({
        id,
        runId: invocation.runId ?? "run",
        threadId: invocation.thread.id,
        agentId: agent.id,
        name: "write",
        permission: "edit",
        status: "waiting_approval",
        input: "{}",
        createdAt: now,
        updatedAt: now,
      }),
    );
    await Promise.all(
      calls.map(async (call) => {
        await invocation.toolHooks?.requestApproval(call);
        this.resolved.push(call.id);
      }),
    );
    return "approved";
  }
}

class StreamingRunner implements AgentRunner {
  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(_agent: Agent, invocation: AgentInvocation) {
    invocation.activityHooks?.status("thinking", "Inspecting the repository");
    invocation.activityHooks?.thinking("Checking the current implementation.", "append");
    invocation.activityHooks?.text("Live answer", "append");
    await invocation.activityHooks?.tool({
      id: "native-read",
      name: "read",
      permission: "read",
      status: "completed",
      input: '{"filePath":"README.md"}',
      summary: "Read README.md",
    });
    return "Live answer";
  }
}

class DelegatingMasterRunner implements AgentRunner {
  readonly invocations: { agent: Agent; invocation: AgentInvocation }[] = [];

  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    this.invocations.push({ agent, invocation });
    if (agent.kind === "worker") return "Implemented and committed the assigned change.";
    if (!invocation.toolHooks?.createPlan || !invocation.toolHooks.delegate) {
      throw new Error("expected planning and delegation hooks");
    }
    const [task] = await invocation.toolHooks.createPlan("Implementation plan", [
      { title: "Implement feature", description: "Make the requested repository change." },
    ]);
    if (!task) throw new Error("expected planned task");
    const delegated = await invocation.toolHooks.delegate({
      taskId: task.id,
      workerHandle: "builder",
      repositoryHandle: "product-repo",
    });
    return `Worker completed ${delegated.assignment.branch}: ${delegated.result}`;
  }
}

class FakeAssignmentRepositories implements AssignmentRepositoryManager {
  constructor(private readonly root: string) {}

  assignmentLocation(workspaceId: string, assignmentId: string): AssignmentLocation {
    return {
      branch: `nexestra/${assignmentId}`,
      worktreePath: `workspaces/${workspaceId}/worktrees/${assignmentId}`,
      absolutePath: join(this.root, "workspaces", workspaceId, "worktrees", assignmentId),
    };
  }

  async prepareAssignment(
    _repository: Parameters<AssignmentRepositoryManager["prepareAssignment"]>[0],
    location: AssignmentLocation,
  ) {
    await mkdir(location.absolutePath, { recursive: true });
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-"));
  const store = await FileStore.open({ root, workspacePath: root });
  const runner = new FakeRunner();
  const dispatcher = new AgentDispatcher(store, runner);
  const chat = new ChatService(store, dispatcher);
  const [thread] = store.listThreads();
  if (!thread) throw new Error("expected seeded thread");
  return { store, runner, dispatcher, chat, thread };
}

describe("mention dispatch", () => {
  it("resolves a mentioned handle only inside the thread workspace", async () => {
    const { chat, dispatcher, runner, store } = await setup();
    const [firstWorkspace] = store.listWorkspaces();
    if (!firstWorkspace) throw new Error("expected default workspace");
    const secondWorkspace = await store.createWorkspace({ name: "Product" });
    await store.createAgent({
      workspaceId: firstWorkspace.id,
      kind: "worker",
      name: "First Planner",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const secondAgent = await store.createAgent({
      workspaceId: secondWorkspace.id,
      kind: "worker",
      name: "Product Planner",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "opencode",
    });
    const [secondThread] = store.listThreads(secondWorkspace.id);
    if (!secondThread) throw new Error("expected workspace thread");

    await chat.send(secondThread.id, { content: "@planner answer here" });
    await dispatcher.waitForIdle();

    expect(runner.invocations.map(({ agent }) => agent.id)).toEqual([secondAgent.id]);
  });

  it("persists ordinary chat without invoking an agent", async () => {
    const { chat, dispatcher, runner, store, thread } = await setup();
    await chat.send(thread.id, { content: "a note without a mention" });
    await dispatcher.waitForIdle();

    expect(runner.invocations).toHaveLength(0);
    expect((await store.threadData(thread.id)).messages).toHaveLength(1);
  });

  it("invokes every mentioned agent once with the same shared snapshot", async () => {
    const { chat, dispatcher, runner, store, thread } = await setup();
    for (const [name, handle, harness] of [
      ["Codex", "codex", "codex"],
      ["OpenCode", "opencode", "opencode"],
    ] as const) {
      await store.createAgent({
        kind: "worker",
        name,
        handle,
        description: "",
        instructions: "",
        harness,
      });
    }

    const result = await chat.send(thread.id, {
      content: "@codex and @opencode please review this. @CODEX remember to reply.",
    });
    await dispatcher.waitForIdle();

    expect(result.runs).toHaveLength(2);
    expect(runner.invocations.map(({ agent }) => agent.handle).sort()).toEqual([
      "codex",
      "opencode",
    ]);
    expect(
      runner.invocations.every(({ invocation }) =>
        invocation.transcriptSnapshot.includes("@codex"),
      ),
    ).toBe(true);
    const data = await store.threadData(thread.id);
    expect(data.messages).toHaveLength(3);
    expect(data.runs.every((run) => run.status === "completed")).toBe(true);
  });

  it("publishes transient response activity and persists native tool events", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-stream-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const dispatcher = new AgentDispatcher(store, new StreamingRunner());
    const chat = new ChatService(store, dispatcher);
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const events: ThreadStreamEvent[] = [];
    const unsubscribe = dispatcher.subscribeThread(thread.id, (event) => events.push(event));

    await chat.send(thread.id, { content: `@${agent.handle} stream this` });
    await dispatcher.waitForIdle();
    unsubscribe();

    expect(
      events.some((event) => event.activities.some((item) => item.text === "Live answer")),
    ).toBe(true);
    expect(
      events.some((event) =>
        event.activities.some((item) => item.thinking === "Checking the current implementation."),
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ refresh: true, activities: [] });
    expect((await store.threadData(thread.id)).toolCalls).toContainEqual(
      expect.objectContaining({
        name: "read",
        status: "completed",
        input: '{"filePath":"README.md"}',
      }),
    );
    expect(await store.transcriptSnapshot(thread.id)).not.toContain(
      "Checking the current implementation.",
    );
  });

  it("keeps each queued invocation bound to its own trigger message", async () => {
    const { chat, dispatcher, runner, store, thread } = await setup();
    await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    const first = await chat.send(thread.id, { content: "@codex first question" });
    const second = await chat.send(thread.id, { content: "@codex second question" });
    await dispatcher.waitForIdle();

    expect(runner.invocations.map(({ invocation }) => invocation.trigger.content)).toEqual([
      "@codex first question",
      "@codex second question",
    ]);
    const replies = (await store.threadData(thread.id)).messages.filter(
      (message) => message.author.kind === "agent",
    );
    expect(replies.map((message) => message.triggerMessageId)).toEqual([
      first.message.id,
      second.message.id,
    ]);
  });

  it("records a clear failure for a disabled mentioned agent", async () => {
    const { chat, dispatcher, store, thread } = await setup();
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    await store.updateAgent(agent.id, { enabled: false });
    await chat.send(thread.id, { content: "@codex are you there?" });
    await dispatcher.waitForIdle();

    const [run] = (await store.threadData(thread.id)).runs;
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("Disabled");
  });

  it("allows only one retry of the latest failed attempt", async () => {
    const { dispatcher, store, thread } = await setup();
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const trigger = await store.createUserMessage(thread.id, "@codex retry", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    const now = new Date().toISOString();
    const failed = await store.updateRun({
      id: crypto.randomUUID(),
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: agent.id,
      attempt: 1,
      status: "failed",
      error: "test failure",
      createdAt: now,
      updatedAt: now,
    });

    const results = await Promise.allSettled([
      dispatcher.retry(failed.id),
      dispatcher.retry(failed.id),
    ]);
    await dispatcher.waitForIdle();
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(dispatcher.retry(failed.id)).rejects.toBeInstanceOf(StoreError);
    expect((await store.threadData(thread.id)).runs).toHaveLength(2);
  });

  it("keeps a run waiting until every concurrent approval is resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-approvals-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const runner = new ConcurrentApprovalRunner();
    const dispatcher = new AgentDispatcher(store, runner);
    const chat = new ChatService(store, dispatcher);
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    await chat.send(thread.id, { content: `@${agent.handle} approve both` });
    await waitUntil(
      async () =>
        (await store.threadData(thread.id)).toolCalls.length === 2 &&
        dispatcher.activeRuns()[0]?.status === "waiting_approval",
    );
    expect(dispatcher.activeRuns()[0]?.status).toBe("waiting_approval");

    dispatcher.resolveToolApproval("first", true);
    await waitUntil(() => runner.resolved.length === 1);
    expect(dispatcher.activeRuns()[0]?.status).toBe("waiting_approval");

    dispatcher.resolveToolApproval("second", true);
    await dispatcher.waitForIdle();
    expect((await store.threadData(thread.id)).runs.at(-1)?.status).toBe("completed");
  });

  it("lets a Master plan work and delegate it to a Worker in an isolated worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-delegation-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const runner = new DelegatingMasterRunner();
    const dispatcher = new AgentDispatcher(
      store,
      runner,
      new FakeAssignmentRepositories(store.root),
    );
    const chat = new ChatService(store, dispatcher);
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const master = await store.createAgent({
      kind: "master",
      name: "Lead",
      handle: "lead",
      description: "",
      instructions: "",
      accessMode: "full",
      provider: {
        type: "custom",
        name: "Test provider",
        baseUrl: "https://example.test/v1",
        model: "test-model",
        protocol: "openai-chat",
      },
    });
    const worker = await store.createAgent({
      kind: "worker",
      name: "Builder",
      handle: "builder",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const repository = await store.createKnowledgeRepository({
      name: "Product repository",
      handle: "product-repo",
      source: "https://github.com/example/product.git",
    });
    await store.updateKnowledgeRepository(repository.id, {
      status: "ready",
      defaultBranch: "main",
    });

    const sent = await chat.send(thread.id, {
      content: "@lead implement the feature in #product-repo",
    });
    await dispatcher.waitForIdle();

    expect(sent.message.knowledgeReferences).toEqual([
      { knowledgeId: repository.id, handle: repository.handle },
    ]);
    expect(runner.invocations.map(({ agent }) => agent.id)).toEqual([master.id, worker.id]);
    const workerInvocation = runner.invocations[1]?.invocation;
    expect(workerInvocation).toMatchObject({ mode: "task" });
    expect(workerInvocation?.workingDirectory).toContain("/worktrees/");
    expect(workerInvocation?.knowledge).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ id: repository.id }),
        localPath: workerInvocation?.workingDirectory,
      }),
    ]);
    expect(store.listAssignments()).toEqual([
      expect.objectContaining({
        status: "completed",
        workerAgentId: worker.id,
        repositoryId: repository.id,
      }),
    ]);
    expect(store.listTasks()).toEqual([
      expect.objectContaining({ status: "done", assigneeId: worker.id, threadId: thread.id }),
    ]);
  });
});

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the test condition.");
}
