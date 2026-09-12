import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Agent, RuntimeStatus, ThreadStreamEvent, ToolCall } from "../shared/contracts.js";
import { AgentDispatcher, ChatService } from "./dispatcher.js";
import type {
  AssignmentLocation,
  AssignmentPreparation,
  AssignmentRepositoryManager,
} from "./repository-manager.js";
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

class GatedRunner implements AgentRunner {
  readonly invocations: { agent: Agent; invocation: AgentInvocation }[] = [];
  private started = false;
  private readonly startedWaiters: (() => void)[] = [];
  private readonly releaseWaiters: (() => void)[] = [];

  async runtimeStatus() {
    return readyRuntime;
  }

  nextInvocationStarted(): Promise<void> {
    if (this.started) return Promise.resolve();
    return new Promise((resolve) => this.startedWaiters.push(resolve));
  }

  release(): void {
    for (const resolve of this.releaseWaiters.splice(0)) resolve();
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    this.invocations.push({ agent, invocation });
    this.started = true;
    for (const resolve of this.startedWaiters.splice(0)) resolve();
    await new Promise<void>((resolve) => this.releaseWaiters.push(resolve));
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

class FailingNetworkRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];

  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(_agent: Agent, invocation: AgentInvocation): Promise<string> {
    this.invocations.push(invocation);
    throw new Error("Network unavailable.");
  }
}

class SecretLeakingRunner implements AgentRunner {
  constructor(private readonly secret: string) {}

  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(): Promise<string> {
    return `accidental output: ${this.secret}`;
  }
}

class DelegatingMasterRunner implements AgentRunner {
  readonly invocations: { agent: Agent; invocation: AgentInvocation }[] = [];

  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    this.invocations.push({ agent, invocation });
    if (agent.kind === "worker") {
      invocation.activityHooks?.status("thinking", "Inspecting the assigned worktree");
      invocation.activityHooks?.thinking("Reviewing the task.", "append");
      await invocation.activityHooks?.tool({
        id: "worker-read",
        name: "read",
        permission: "read",
        status: "completed",
        input: '{"filePath":"README.md"}',
        summary: "Read README.md",
      });
      invocation.activityHooks?.text("Implemented and committed", "append");
      return "Implemented and committed the assigned change.";
    }
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

class StoppableDelegatingMasterRunner implements AgentRunner {
  workerStarted = false;

  async runtimeStatus() {
    return readyRuntime;
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    if (agent.kind === "worker") {
      this.workerStarted = true;
      await invocation.activityHooks?.tool({
        id: "worker-write",
        name: "write",
        permission: "edit",
        status: "running",
        input: '{"filePath":"src/index.ts"}',
      });
      return new Promise<string>((_resolve, reject) => {
        if (invocation.signal?.aborted) {
          reject(invocation.signal.reason);
          return;
        }
        invocation.signal?.addEventListener(
          "abort",
          () => reject(invocation.signal?.reason ?? new Error("Worker stopped.")),
          { once: true },
        );
      });
    }
    if (!invocation.toolHooks?.createPlan || !invocation.toolHooks.delegate) {
      throw new Error("expected planning and delegation hooks");
    }
    const [task] = await invocation.toolHooks.createPlan("Implementation plan", [
      { title: "Implement feature", description: "Make the requested repository change." },
    ]);
    if (!task) throw new Error("expected planned task");
    try {
      await invocation.toolHooks.delegate({
        taskId: task.id,
        workerHandle: "builder",
        repositoryHandle: "product-repo",
      });
    } catch {
      return "The Worker process was stopped.";
    }
    return "The Worker completed unexpectedly.";
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
  ): Promise<AssignmentPreparation | undefined> {
    await mkdir(location.absolutePath, { recursive: true });
    return undefined;
  }

  async cleanupAssignment() {}

  async deleteAssignmentBranch() {}
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

  it("redacts stored credentials from Worker replies before persisting them", async () => {
    const secret = "sk-test-transcript-secret";
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-redaction-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const dispatcher = new AgentDispatcher(store, new SecretLeakingRunner(secret));
    const chat = new ChatService(store, dispatcher);
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await store.createAgent({
      kind: "master",
      name: "Gateway",
      handle: "gateway",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://example.test/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: secret,
      },
    });
    const worker = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    await chat.send(thread.id, { content: `@${worker.handle} inspect this` });
    await dispatcher.waitForIdle();

    const snapshot = await store.transcriptSnapshot(thread.id);
    expect(snapshot).toContain("accidental output: [REDACTED]");
    expect(snapshot).not.toContain(secret);
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
    const replies = data.messages.filter((message) => message.author.kind === "agent");
    expect(replies).toHaveLength(2);
    for (const reply of replies) {
      const producingRun = data.runs.find((run) => run.id === reply.runId);
      expect(producingRun).toMatchObject({
        agentId: reply.author.id,
        triggerMessageId: result.message.id,
      });
    }
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

  it("pins a queued invocation to the document revision at message persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-gated-pin-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const runner = new GatedRunner();
    const dispatcher = new AgentDispatcher(store, runner);
    const chat = new ChatService(store, dispatcher);
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const item = await store.createKnowledgeDocument(
      { name: "Document", handle: "doc", description: "" },
      {
        name: "doc.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# v1"),
      },
    );
    const sent = chat.send(thread.id, { content: "@codex read #doc" });
    await runner.nextInvocationStarted();
    await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: item.currentRevisionId },
      {
        name: "doc-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# v2"),
      },
    );
    runner.release();
    await Promise.all([sent, dispatcher.waitForIdle()]);
    const invocation = runner.invocations[0]?.invocation;
    expect(invocation?.knowledge).toEqual([expect.objectContaining({ content: "# v1" })]);
  });

  it("keeps the pinned revision when a failed run is retried after replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-gated-pin-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const runner = new GatedRunner();
    const dispatcher = new AgentDispatcher(store, runner);
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
    const item = await store.createKnowledgeDocument(
      { name: "Document", handle: "doc", description: "" },
      {
        name: "doc.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# v1"),
      },
    );
    const trigger = await store.createUserMessage(
      thread.id,
      "@codex retry #doc",
      [{ agentId: agent.id, handle: agent.handle }],
      [],
      [{ knowledgeId: item.id, handle: item.handle }],
    );
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
    await store.replaceKnowledgeDocument(
      item.id,
      { expectedRevisionId: item.currentRevisionId },
      {
        name: "doc-v2.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# v2"),
      },
    );
    const retried = dispatcher.retry(failed.id);
    await runner.nextInvocationStarted();
    const invocation = runner.invocations[0]?.invocation;
    expect(invocation?.knowledge).toEqual([expect.objectContaining({ content: "# v1" })]);
    runner.release();
    await Promise.all([retried, dispatcher.waitForIdle()]);
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

  it("stops automatically retrying a transient failure after two retries", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler) => {
      handler();
      return 0 as unknown as NodeJS.Timeout;
    });
    try {
      const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-auto-retry-"));
      const store = await FileStore.open({ root, workspacePath: root });
      const runner = new FailingNetworkRunner();
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

      await chat.send(thread.id, { content: `@${agent.handle} retry a transient failure` });
      await dispatcher.waitForIdle();

      expect(runner.invocations).toHaveLength(3);
      const runs = (await store.threadData(thread.id)).runs;
      expect(runs.map((run) => run.attempt)).toEqual([1, 2, 3]);
      expect(runs.every((run) => run.status === "failed")).toBe(true);
      expect(dispatcher.activeRuns()).toEqual([]);
    } finally {
      timeout.mockRestore();
    }
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
    const [assignment] = store.listAssignments();
    expect(assignment).toEqual(
      expect.objectContaining({
        status: "completed",
        workerAgentId: worker.id,
        repositoryId: repository.id,
      }),
    );
    if (!assignment) throw new Error("expected Worker assignment");
    const [plannedTask] = store.listTasks();
    expect(plannedTask).toEqual(
      expect.objectContaining({ status: "done", assigneeId: worker.id, threadId: thread.id }),
    );
    if (!plannedTask) throw new Error("expected planned task");
    const threadData = await store.threadData(thread.id);
    expect(threadData.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: assignment.id, agentId: worker.id, status: "completed" }),
      ]),
    );
    expect(threadData.toolCalls).toEqual([
      expect.objectContaining({ runId: assignment.id, name: "read", status: "completed" }),
    ]);
    expect(threadData.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          author: expect.objectContaining({ kind: "agent", id: worker.id }),
          content: "Implemented and committed the assigned change.",
          triggerMessageId: sent.message.id,
          runId: assignment.id,
        }),
      ]),
    );
    const masterRun = threadData.runs.find((run) => run.agentId === master.id);
    expect(masterRun).toBeDefined();
    expect(
      threadData.messages
        .filter((message) => message.author.kind === "agent" && message.author.id === master.id)
        .every((message) => message.runId === masterRun?.id),
    ).toBe(true);
    await expect(dispatcher.taskProcess(plannedTask.id)).resolves.toMatchObject({
      assignment: { id: assignment.id, status: "completed" },
      run: { id: assignment.id, status: "completed" },
      toolCalls: [{ runId: assignment.id, name: "read" }],
    });
  });

  it("delegates work without requiring #repository in the user message", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-no-ref-"));
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
    await store.createAgent({
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
    await store.createAgent({
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
      content: "@lead implement the feature",
    });
    await dispatcher.waitForIdle();

    expect(sent.message.knowledgeReferences).toEqual([]);
    expect(runner.invocations.map(({ agent }) => agent.id)).toHaveLength(2);
    const [assignment] = store.listAssignments();
    expect(assignment).toEqual(
      expect.objectContaining({
        status: "completed",
        repositoryId: repository.id,
      }),
    );
  });

  it("runs a task verification command in the manual Worker worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-verify-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const runner = new FakeRunner();
    const dispatcher = new AgentDispatcher(
      store,
      runner,
      new FakeAssignmentRepositories(store.root),
    );
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
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
    const task = await store.createTask({
      title: "Implement feature",
      description: "Build it.",
      assigneeId: worker.id,
      threadId: thread.id,
      verificationCommand: "printf verification-passed",
    });

    const queued = await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    expect(queued.status).toBe("queued");
    await dispatcher.waitForIdle();
    const assignment = (await dispatcher.taskProcess(task.id)).assignment;

    expect(assignment).toMatchObject({
      status: "completed",
      verificationExitCode: 0,
      verificationOutput: "verification-passed",
    });
    expect(store.getTask(task.id)).toMatchObject({ status: "done" });
  });

  it("blocks a task when its verification command fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-verify-fail-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const runner = new FakeRunner();
    const dispatcher = new AgentDispatcher(
      store,
      runner,
      new FakeAssignmentRepositories(store.root),
    );
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
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
    const task = await store.createTask({
      title: "Implement feature",
      description: "Build it.",
      assigneeId: worker.id,
      threadId: thread.id,
      verificationCommand: "printf verification-failed >&2; exit 42",
    });

    const queued = await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    expect(queued.status).toBe("queued");
    await dispatcher.waitForIdle();
    const assignment = (await dispatcher.taskProcess(task.id)).assignment;

    expect(assignment).toMatchObject({
      status: "completed",
      verificationExitCode: 42,
      verificationOutput: "verification-failed",
    });
    expect(store.getTask(task.id)).toMatchObject({ status: "blocked" });

    await dispatcher.delegateFromTask(task.id, worker.handle, repository.handle);
    await dispatcher.waitForIdle();
    const retried = (await dispatcher.taskProcess(task.id)).assignment;
    expect(retried?.id).not.toBe(assignment?.id);
    expect(retried).toMatchObject({
      status: "completed",
      verificationExitCode: 42,
      workerAgentId: worker.id,
      repositoryId: repository.id,
    });
    const process = await dispatcher.taskProcess(task.id);
    expect(process.assignment?.id).toBe(retried?.id);
    expect(process.assignments.map((entry) => entry.id)).toEqual([assignment?.id, retried?.id]);
  });

  it("stops an active Worker process and preserves interrupted run and tool history", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-dispatch-stop-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const runner = new StoppableDelegatingMasterRunner();
    const dispatcher = new AgentDispatcher(
      store,
      runner,
      new FakeAssignmentRepositories(store.root),
    );
    const chat = new ChatService(store, dispatcher);
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await store.createAgent({
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
    await store.createAgent({
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

    await chat.send(thread.id, { content: "@lead implement the feature in #product-repo" });
    await waitUntil(() => runner.workerStarted);
    const [task] = store.listTasks();
    if (!task) throw new Error("expected planned task");

    await expect(dispatcher.stopTask(task.id)).resolves.toMatchObject({
      assignment: { status: "interrupted" },
      run: { status: "interrupted" },
      toolCalls: [{ status: "interrupted" }],
    });
    await dispatcher.waitForIdle();

    expect(store.getTask(task.id)).toMatchObject({ status: "todo", assigneeId: null });
    expect(store.listAssignments()).toEqual([
      expect.objectContaining({ status: "interrupted", error: expect.stringContaining("stopped") }),
    ]);
    const threadData = await store.threadData(thread.id);
    expect(threadData.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: expect.any(String), status: "interrupted" }),
      ]),
    );
    expect(threadData.toolCalls).toEqual([
      expect.objectContaining({ name: "write", status: "interrupted" }),
    ]);
  });

  it("lets an archive win over a retry whose thread lookup is still pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-retry-archive-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Archiver",
      handle: "archiver",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const trigger = await store.createUserMessage(thread.id, "retry me", [
      { agentId: agent.id, handle: agent.handle },
    ]);
    const run = {
      id: "run-to-retry",
      threadId: thread.id,
      triggerMessageId: trigger.id,
      agentId: agent.id,
      attempt: 1,
      status: "failed" as const,
      error: "Network unavailable.",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.updateRun(run);
    const dispatcher = new AgentDispatcher(store, new FakeRunner());

    const originalThreadData = store.threadData.bind(store);
    let gateOpened = false;
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let dataCalls = 0;
    vi.spyOn(store, "threadData").mockImplementation(async (threadId) => {
      dataCalls += 1;
      const result = await originalThreadData(threadId);
      if (dataCalls === 1) {
        gateOpened = true;
        await gate;
      }
      return result;
    });

    const retryPromise = dispatcher.retry(run.id);
    await waitUntil(() => gateOpened);
    await expect(dispatcher.archiveThread(thread.id)).resolves.toMatchObject({ archived: true });
    releaseGate();
    await expect(retryPromise).rejects.toMatchObject({ code: "conflict" });

    const after = await store.threadData(thread.id);
    expect(after.runs).toHaveLength(1);
    expect(after.messages).toHaveLength(1);
    expect(store.getThread(thread.id)).toMatchObject({ archived: true });
  });

  it("releases a rejected send reservation so archiving can proceed", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-send-archive-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Busy Agent",
      handle: "busy",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const dispatcher = new AgentDispatcher(store, new FakeRunner());
    const chat = new ChatService(store, dispatcher);

    const originalUpdateAgent = store.updateAgent.bind(store);
    let mutationEntered = false;
    let releaseMutation: () => void = () => undefined;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    vi.spyOn(store, "updateAgent").mockImplementation(async (id, input) => {
      const result = await originalUpdateAgent(id, input);
      mutationEntered = true;
      await mutationGate;
      return result;
    });
    const updatePromise = dispatcher.updateAgent(agent.id, { name: "Being Changed" });
    await waitUntil(() => mutationEntered);

    await expect(chat.send(thread.id, { content: "@busy hello" })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(dispatcher.archiveThread(thread.id)).resolves.toMatchObject({ archived: true });

    releaseMutation();
    await updatePromise;
  });
});

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the test condition.");
}
