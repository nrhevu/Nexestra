import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, RuntimeStatus } from "../shared/contracts.js";
import { createApp } from "./app.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

const runtime: RuntimeStatus = {
  chatgpt: { installed: true, connected: true, message: "Logged in using ChatGPT" },
  harnesses: {
    codex: { installed: true, version: "test" },
    opencode: { installed: true, version: "test" },
  },
};

class FakeRunner implements AgentRunner {
  invocations = 0;
  lastInvocation?: AgentInvocation;
  gate?: Promise<void>;
  requireToolApproval = false;
  requireToolQuestion = false;
  approvalRequested: Promise<void> = Promise.resolve();
  questionRequested: Promise<void> = Promise.resolve();
  private markApprovalRequested: () => void = () => undefined;
  private markQuestionRequested: () => void = () => undefined;

  prepareToolApproval() {
    this.requireToolApproval = true;
    this.approvalRequested = new Promise<void>((resolve) => {
      this.markApprovalRequested = resolve;
    });
  }

  prepareToolQuestion() {
    this.requireToolQuestion = true;
    this.questionRequested = new Promise<void>((resolve) => {
      this.markQuestionRequested = resolve;
    });
  }

  async runtimeStatus() {
    return runtime;
  }

  async invoke(agent: Agent, invocation: AgentInvocation) {
    this.invocations += 1;
    this.lastInvocation = invocation;
    await this.gate;
    if (this.requireToolApproval) {
      if (!invocation.runId || !invocation.toolHooks) throw new Error("missing tool hooks");
      const now = new Date().toISOString();
      const toolCall = {
        id: "tool-approval",
        runId: invocation.runId,
        threadId: invocation.thread.id,
        agentId: agent.id,
        name: "bash" as const,
        permission: "bash" as const,
        status: "waiting_approval" as const,
        input: '{"command":"pnpm test"}',
        createdAt: now,
        updatedAt: now,
      };
      const decision = invocation.toolHooks.requestApproval(toolCall);
      this.markApprovalRequested();
      const approved = await decision;
      await invocation.toolHooks.update({
        ...toolCall,
        status: approved ? "completed" : "denied",
        summary: approved ? "Command finished." : "Denied by the user.",
        updatedAt: new Date().toISOString(),
      });
    }
    if (this.requireToolQuestion) {
      if (!invocation.runId || !invocation.toolHooks?.requestInput) {
        throw new Error("missing question hooks");
      }
      const now = new Date().toISOString();
      const toolCall = {
        id: "tool-question",
        runId: invocation.runId,
        threadId: invocation.thread.id,
        agentId: agent.id,
        name: "question" as const,
        permission: "question" as const,
        status: "waiting_input" as const,
        input: '{"questions":[{"question":"Continue?"}]}',
        questions: [
          {
            header: "Decision",
            question: "Continue?",
            options: [{ label: "Proceed", description: "Keep going." }],
            multiple: false,
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const answer = invocation.toolHooks.requestInput(toolCall);
      this.markQuestionRequested();
      const answers = await answer;
      await invocation.toolHooks.update({
        ...toolCall,
        answers,
        status: "completed",
        summary: "User answered.",
        updatedAt: new Date().toISOString(),
      });
    }
    return `Hello from ${agent.name}`;
  }
}

describe("HTTP app", () => {
  let store: FileStore;
  let runner: FakeRunner;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-app-"));
    store = await FileStore.open({ root, workspacePath: root });
    runner = new FakeRunner();
    app = createApp({ store, runner });
  });

  it("creates a workspace and returns only its scoped bootstrap data", async () => {
    const response = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Product Team" }),
    });
    expect(response.status).toBe(201);
    const workspace = (await response.json()) as { id: string; name: string };

    await store.createAgent({
      workspaceId: workspace.id,
      kind: "worker",
      name: "Product Planner",
      handle: "planner",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const bootstrap = await app.request(`/api/bootstrap?workspaceId=${workspace.id}`);

    await expect(bootstrap.json()).resolves.toMatchObject({
      workspace: { id: workspace.id, name: "Product Team" },
      workspaces: [{ name: "Nexestra" }, { id: workspace.id, name: "Product Team" }],
      agents: [{ workspaceId: workspace.id, handle: "planner" }],
      threads: [{ workspaceId: workspace.id, name: "general" }],
      tasks: [],
    });
  });

  it("creates an agent and dispatches only an explicit mention", async () => {
    const agentResponse = await app.request("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "worker",
        name: "Codex",
        handle: "codex",
        description: "",
        instructions: "",
        harness: "codex",
        model: "gpt-test",
        reasoningEffort: "high",
      }),
    });
    expect(agentResponse.status).toBe(201);
    await expect(agentResponse.json()).resolves.toMatchObject({
      kind: "worker",
      harness: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");

    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "regular note" }),
    });
    expect(runner.invocations).toBe(0);

    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex please reply" }),
    });
    await app.dispatcher.waitForIdle();
    expect(runner.invocations).toBe(1);
    const data = await store.threadData(thread.id);
    expect(data.messages.at(-1)?.content).toBe("Hello from Codex");
  });

  it("uploads an image with a message and serves it from the thread artifact endpoint", async () => {
    await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const form = new FormData();
    form.append("content", "@codex inspect this image");
    form.append(
      "files",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "diagram.png", {
        type: "image/png",
      }),
    );

    const sent = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      body: form,
    });
    expect(sent.status).toBe(201);
    await app.dispatcher.waitForIdle();
    expect(runner.lastInvocation?.artifacts).toMatchObject([
      { artifact: { kind: "image", name: "diagram.png" } },
    ]);

    const data = await store.threadData(thread.id);
    const artifact = data.artifacts.find((entry) => entry.name === "diagram.png");
    if (!artifact) throw new Error("expected image artifact");
    const response = await app.request(
      `/api/threads/${thread.id}/artifacts/${artifact.id}/content`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("uploads a shared knowledge document and serves it from the knowledge endpoint", async () => {
    const form = new FormData();
    form.append("name", "Architecture guide");
    form.append("handle", "architecture");
    form.append("description", "Repository conventions");
    form.append(
      "file",
      new File(["# Architecture\n"], "architecture.md", { type: "text/markdown" }),
    );
    const created = await app.request("/api/knowledge/documents", {
      method: "POST",
      body: form,
    });

    expect(created.status).toBe(201);
    const item = (await created.json()) as { id: string; handle: string; mediaType: string };
    expect(item).toMatchObject({ handle: "architecture", mediaType: "text/markdown" });
    const content = await app.request(`/api/knowledge/${item.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-disposition")).toContain("architecture.md");
    await expect(content.text()).resolves.toBe("# Architecture\n");
    const bootstrap = await app.request("/api/bootstrap");
    await expect(bootstrap.json()).resolves.toMatchObject({
      knowledge: [expect.objectContaining({ id: item.id, handle: "architecture" })],
      assignments: [],
    });
  });

  it("reports live activity without scanning persisted thread history", async () => {
    let releaseRunner: () => void = () => undefined;
    runner.gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    const sent = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex keep working" }),
    });
    expect(sent.status).toBe(201);

    const active = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(active.json()).resolves.toMatchObject({
      activeRuns: [{ agentId: agent.id, threadId: thread.id }],
    });

    releaseRunner();
    await app.dispatcher.waitForIdle();
    const idle = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(idle.json()).resolves.toEqual({ activeRuns: [] });
  });

  it("opens a thread event stream with an immediate activity snapshot", async () => {
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");

    const response = await app.request(`/api/threads/${thread.id}/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected event stream body");
    const chunk = await reader.read();
    await reader.cancel();

    expect(new TextDecoder().decode(chunk.value)).toContain("event: thread");
    expect(new TextDecoder().decode(chunk.value)).toContain('"activities":[]');
  });

  it("rejects mutating browser requests from a non-loopback origin", async () => {
    const response = await app.request("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "blocked" }),
    });
    expect(response.status).toBe(403);
  });

  it("approves a pending Master tool call and resumes the run", async () => {
    runner.prepareToolApproval();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      accessMode: "ask",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@maya run the tests" }),
    });
    await runner.approvalRequested;

    const approval = await app.request("/api/tool-calls/tool-approval/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(approval.status).toBe(204);
    await app.dispatcher.waitForIdle();

    const data = await store.threadData(thread.id);
    expect(data.runs).toMatchObject([{ status: "completed" }]);
    expect(data.toolCalls).toMatchObject([
      { id: "tool-approval", status: "completed", summary: "Command finished." },
    ]);
    expect(data.messages.at(-1)?.content).toBe(`Hello from ${agent.name}`);
  });

  it("accepts an answer for a pending Master question and resumes the run", async () => {
    runner.prepareToolQuestion();
    const agent = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "model-a",
        protocol: "openai-chat",
      },
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@maya ask me" }),
    });
    await runner.questionRequested;

    const response = await app.request("/api/tool-calls/tool-question/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [["Proceed"]] }),
    });
    expect(response.status).toBe(204);
    await app.dispatcher.waitForIdle();

    const data = await store.threadData(thread.id);
    expect(data.runs).toMatchObject([{ status: "completed" }]);
    expect(data.toolCalls).toMatchObject([
      { id: "tool-question", status: "completed", answers: [["Proceed"]] },
    ]);
    expect(data.messages.at(-1)?.content).toBe(`Hello from ${agent.name}`);
  });

  it("permanently deletes an idle agent and returns not found when repeated", async () => {
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });

    const response = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(store.getAgent(agent.id)).toBeUndefined();

    const bootstrap = await app.request("/api/bootstrap");
    await expect(bootstrap.json()).resolves.toMatchObject({ agents: [] });

    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const note = await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "Keep @codex as plain text" }),
    });
    expect(note.status).toBe(201);
    await expect(note.json()).resolves.toMatchObject({
      message: { content: "Keep @codex as plain text", mentions: [] },
      runs: [],
    });
    expect(runner.invocations).toBe(0);

    const repeated = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(repeated.status).toBe(404);
    await expect(repeated.json()).resolves.toMatchObject({
      error: { code: "not_found", message: "Agent not found." },
    });
  });

  it("rejects deletion while an agent has queued or running work", async () => {
    let releaseRunner: () => void = () => undefined;
    runner.gate = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");

    await app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex wait" }),
    });

    const blocked = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });

    releaseRunner();
    await app.dispatcher.waitForIdle();
    const deleted = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });

  it("rejects deletion after chat reserves an agent but before persisting the message", async () => {
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const createUserMessage = store.createUserMessage.bind(store);
    let markPersistenceStarted: () => void = () => undefined;
    let resumePersistence: () => void = () => undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    const persistenceGate = new Promise<void>((resolve) => {
      resumePersistence = resolve;
    });
    store.createUserMessage = async (threadId, content, mentions) => {
      markPersistenceStarted();
      await persistenceGate;
      return createUserMessage(threadId, content, mentions);
    };

    const send = app.request(`/api/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@codex race" }),
    });
    await persistenceStarted;

    const blocked = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect(store.getAgent(agent.id)).toBeDefined();

    resumePersistence();
    expect((await send).status).toBe(201);
    await app.dispatcher.waitForIdle();
    const deleted = await app.request(`/api/agents/${agent.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
  });

  it("keeps unknown API paths inside the JSON error namespace", async () => {
    const response = await app.request("/api");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
