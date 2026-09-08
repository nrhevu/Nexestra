import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, RuntimeStatus } from "../shared/contracts.js";
import { createApp } from "./app.js";
import type { AssignmentRepositoryManager } from "./repository-manager.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

const execFileAsync = promisify(execFile);

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
    await store.createTask({ title: "Other workspace blocker", status: "blocked" });
    const task = await store.createTask({
      workspaceId: workspace.id,
      title: "Product decision",
      status: "blocked",
    });
    const bootstrap = await app.request(`/api/bootstrap?workspaceId=${workspace.id}`);

    await expect(bootstrap.json()).resolves.toMatchObject({
      workspace: { id: workspace.id, name: "Product Team" },
      workspaces: [{ name: "Nexestra" }, { id: workspace.id, name: "Product Team" }],
      agents: [{ workspaceId: workspace.id, handle: "planner" }],
      threads: [{ workspaceId: workspace.id, name: "general" }],
      tasks: [{ id: task.id, workspaceId: workspace.id }],
      attention: [{ id: `task:${task.id}`, kind: "task_blocked", title: task.title }],
    });
    const activity = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(activity.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      activeRuns: [],
      attention: [{ id: `task:${task.id}`, kind: "task_blocked", title: task.title }],
    });
  });

  it("renames and reorders workspaces and rejects stale or duplicate order payloads", async () => {
    const [workspace] = store.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Product Team" }),
    });
    expect(created.status).toBe(201);
    const product = (await created.json()) as { id: string };

    const rename = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Nexus Studio" }),
    });
    expect(rename.status).toBe(200);
    await expect(rename.json()).resolves.toMatchObject({
      id: workspace.id,
      name: "Nexus Studio",
      slug: "nexus-studio",
    });

    const order = await app.request("/api/workspaces/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [product.id, workspace.id] }),
    });
    expect(order.status).toBe(200);
    await expect(order.json()).resolves.toMatchObject([{ id: product.id }, { id: workspace.id }]);

    const listed = await app.request("/api/workspaces");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject([{ id: product.id }, { id: workspace.id }]);

    const stale = await app.request("/api/workspaces/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [workspace.id] }),
    });
    expect(stale.status).toBe(409);
    const duplicate = await app.request("/api/workspaces/order", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [workspace.id, workspace.id] }),
    });
    expect(duplicate.status).toBe(400);

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    expect(reopened.listWorkspaces().map((entry) => entry.id)).toEqual([product.id, workspace.id]);
  });

  it.each(["bootstrap", "activity"])(
    "rejects an explicitly unknown workspace for %s instead of returning another workspace",
    async (endpoint) => {
      for (const workspaceId of ["missing-workspace", ""]) {
        const response = await app.request(`/api/${endpoint}?workspaceId=${workspaceId}`);
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "not_found", message: "Workspace not found." },
        });
      }
    },
  );

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

  it("creates, reads, updates, and deletes shared knowledge", async () => {
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
    const details = await app.request(`/api/knowledge/${item.id}`);
    expect(details.status).toBe(200);
    await expect(details.json()).resolves.toMatchObject({ id: item.id, handle: "architecture" });
    const updated = await app.request(`/api/knowledge/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "System architecture",
        handle: "system-architecture",
        description: "Current system boundaries",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      name: "System architecture",
      handle: "system-architecture",
      description: "Current system boundaries",
    });
    const bootstrap = await app.request("/api/bootstrap");
    await expect(bootstrap.json()).resolves.toMatchObject({
      knowledge: [expect.objectContaining({ id: item.id, handle: "system-architecture" })],
      assignments: [],
    });
    const deleted = await app.request(`/api/knowledge/${item.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await app.request(`/api/knowledge/${item.id}`)).status).toBe(404);
  });

  it("creates, reads, updates, and deletes a Taskboard task", async () => {
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Draft documentation",
        description: "Write the first draft.",
        status: "todo",
        assigneeId: null,
        threadId: null,
        verificationCommand: "pnpm test",
      }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };

    const details = await app.request(`/api/tasks/${task.id}`);
    expect(details.status).toBe(200);
    await expect(details.json()).resolves.toMatchObject({
      id: task.id,
      title: "Draft documentation",
    });
    const updated = await app.request(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Publish documentation",
        description: "Review and publish the draft.",
        status: "blocked",
        verificationCommand: "pnpm check",
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      title: "Publish documentation",
      description: "Review and publish the draft.",
      status: "blocked",
      verificationCommand: "pnpm check",
    });

    const deleted = await app.request(`/api/tasks/${task.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    expect((await app.request(`/api/tasks/${task.id}`)).status).toBe(404);
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

    await vi.waitFor(() => expect(runner.lastInvocation).toBeDefined());
    const transcript = vi.spyOn(store, "threadData").mockRejectedValue(new Error("No transcript"));

    const active = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(active.json()).resolves.toMatchObject({
      workspaceId: workspace.id,
      activeRuns: [{ agentId: agent.id, threadId: thread.id }],
      attention: [],
    });
    const bootstrap = await app.request(`/api/bootstrap?workspaceId=${workspace.id}`);
    await expect(bootstrap.json()).resolves.toMatchObject({
      activeRuns: [{ agentId: agent.id, threadId: thread.id }],
      attention: [],
    });
    expect(transcript).not.toHaveBeenCalled();
    transcript.mockRestore();

    releaseRunner();
    await app.dispatcher.waitForIdle();
    const idle = await app.request(`/api/activity?workspaceId=${workspace.id}`);
    await expect(idle.json()).resolves.toEqual({
      workspaceId: workspace.id,
      activeRuns: [],
      attention: [],
    });
  });

  it("returns the persisted Worker process for a Taskboard task", async () => {
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace");
    const master = await store.createAgent({
      kind: "master",
      name: "Lead",
      handle: "lead",
      description: "",
      instructions: "",
      accessMode: "full",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://example.test/v1",
        model: "model-a",
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
    const task = await store.createTask({
      title: "Implement feature",
      description: "Build and test it.",
      status: "in_progress",
      assigneeId: worker.id,
      threadId: thread.id,
    });
    const now = new Date().toISOString();
    const assignmentId = crypto.randomUUID();
    await store.createAssignment({
      id: assignmentId,
      workspaceId: workspace.id,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: master.id,
      workerAgentId: worker.id,
      repositoryId: repository.id,
      status: "running",
      branch: `nexestra/${assignmentId}`,
      worktreePath: `workspaces/${workspace.id}/worktrees/${assignmentId}`,
      createdAt: now,
      updatedAt: now,
    });
    await store.updateRun({
      id: assignmentId,
      threadId: thread.id,
      triggerMessageId: "message-1",
      agentId: worker.id,
      attempt: 1,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await store.updateToolCall({
      id: `${assignmentId}:read`,
      runId: assignmentId,
      threadId: thread.id,
      agentId: worker.id,
      name: "read",
      permission: "read",
      status: "completed",
      input: '{"filePath":"README.md"}',
      createdAt: now,
      updatedAt: now,
    });

    const response = await app.request(`/api/tasks/${task.id}/process`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      task: { id: task.id },
      assignment: { id: assignmentId, workerAgentId: worker.id },
      run: { id: assignmentId, status: "running" },
      toolCalls: [{ runId: assignmentId, name: "read" }],
    });

    const stopped = await app.request(`/api/tasks/${task.id}/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({
      task: { id: task.id, status: "todo", assigneeId: null },
      assignment: { id: assignmentId, status: "interrupted" },
      run: { id: assignmentId, status: "interrupted" },
    });
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

    await vi.waitFor(async () => {
      const pending = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
      expect(await pending.json()).toMatchObject({
        attention: [{ kind: "approval", threadId: thread.id, title: "Maya in #general" }],
      });
    });

    const approval = await app.request("/api/tool-calls/tool-approval/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(approval.status).toBe(204);
    await app.dispatcher.waitForIdle();

    const cleared = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
    await expect(cleared.json()).resolves.toMatchObject({ attention: [] });

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

    await vi.waitFor(async () => {
      const pending = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
      expect(await pending.json()).toMatchObject({
        attention: [{ kind: "input", threadId: thread.id, title: "Maya in #general" }],
      });
    });

    const response = await app.request("/api/tool-calls/tool-question/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [["Proceed"]] }),
    });
    expect(response.status).toBe(204);
    await app.dispatcher.waitForIdle();

    const cleared = await app.request(`/api/activity?workspaceId=${thread.workspaceId}`);
    await expect(cleared.json()).resolves.toMatchObject({ attention: [] });

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

  it("opens assignment worktrees by absolute path without invoking a shell", async () => {
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace and thread");
    const now = new Date().toISOString();
    const assignmentId = "assignment-open";
    const relativeWorktree = `workspaces/${workspace.id}/worktrees/${assignmentId}`;
    await store.createAssignment({
      id: assignmentId,
      workspaceId: workspace.id,
      taskId: "task-open",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: "repository-open",
      status: "completed",
      branch: `nexestra/${assignmentId}`,
      worktreePath: relativeWorktree,
      createdAt: now,
      updatedAt: now,
    });
    const launchPath = vi.fn(async () => undefined);
    app = createApp({ store, runner, launchPath });

    const opened = await app.request(`/api/assignments/${assignmentId}/open`, { method: "POST" });
    const revealed = await app.request(`/api/assignments/${assignmentId}/reveal`, {
      method: "POST",
    });

    expect(opened.status).toBe(204);
    expect(revealed.status).toBe(204);
    expect(launchPath).toHaveBeenNthCalledWith(1, join(store.root, relativeWorktree), false);
    expect(launchPath).toHaveBeenNthCalledWith(2, join(store.root, relativeWorktree), true);

    await store.createAssignment({
      id: "assignment-outside",
      workspaceId: workspace.id,
      taskId: "task-outside",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: "repository-open",
      status: "completed",
      branch: "nexestra/assignment-outside",
      worktreePath: "../../outside",
      createdAt: now,
      updatedAt: now,
    });
    const blocked = await app.request("/api/assignments/assignment-outside/open", {
      method: "POST",
    });
    expect(blocked.status).toBe(400);
    expect(launchPath).toHaveBeenCalledTimes(2);
  });

  it("cleans up only finished assignment worktrees", async () => {
    const [workspace] = store.listWorkspaces();
    const [thread] = store.listThreads();
    if (!workspace || !thread) throw new Error("expected seeded workspace and thread");
    const repository = await store.createKnowledgeRepository({
      workspaceId: workspace.id,
      name: "Product repository",
      handle: "product-repo",
      description: "",
      source: "/tmp/product-repo",
    });
    await store.updateKnowledgeRepository(repository.id, {
      status: "ready",
      defaultBranch: "main",
    });
    const now = new Date().toISOString();
    const assignmentId = "assignment-cleanup";
    const relativeWorktree = `workspaces/${workspace.id}/worktrees/${assignmentId}`;
    await store.createAssignment({
      id: assignmentId,
      workspaceId: workspace.id,
      taskId: "task-cleanup",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: repository.id,
      status: "completed",
      branch: `nexestra/${assignmentId}`,
      worktreePath: relativeWorktree,
      createdAt: now,
      updatedAt: now,
    });
    const cleanupAssignment = vi.fn(async () => undefined);
    const deleteAssignmentBranch = vi.fn(async () => undefined);
    const repositories: AssignmentRepositoryManager = {
      assignmentLocation: (workspaceId, id) => ({
        branch: `nexestra/${id}`,
        worktreePath: `workspaces/${workspaceId}/worktrees/${id}`,
        absolutePath: join(store.root, "workspaces", workspaceId, "worktrees", id),
      }),
      prepareAssignment: async () => undefined,
      cleanupAssignment,
      deleteAssignmentBranch,
    };
    app = createApp({ store, runner, repositories });

    const cleaned = await app.request(`/api/assignments/${assignmentId}/cleanup`, {
      method: "POST",
    });
    expect(cleaned.status).toBe(200);
    const updated = (await cleaned.json()) as { worktreeCleanedAt?: string };
    expect(updated.worktreeCleanedAt).toEqual(expect.any(String));
    expect(cleanupAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ id: repository.id }),
      expect.objectContaining({
        branch: `nexestra/${assignmentId}`,
        worktreePath: relativeWorktree,
        absolutePath: join(store.root, relativeWorktree),
      }),
    );

    const repeat = await app.request(`/api/assignments/${assignmentId}/cleanup`, {
      method: "POST",
    });
    expect(repeat.status).toBe(409);
    const branchDeleted = await app.request(`/api/assignments/${assignmentId}/branch`, {
      method: "POST",
    });
    expect(branchDeleted.status).toBe(200);
    const deleted = (await branchDeleted.json()) as { branchDeletedAt?: string };
    expect(deleted.branchDeletedAt).toEqual(expect.any(String));
    expect(deleteAssignmentBranch).toHaveBeenCalledWith(
      expect.objectContaining({ id: repository.id }),
      expect.objectContaining({
        branch: `nexestra/${assignmentId}`,
        worktreePath: relativeWorktree,
        absolutePath: join(store.root, relativeWorktree),
      }),
    );
    const branchRepeat = await app.request(`/api/assignments/${assignmentId}/branch`, {
      method: "POST",
    });
    expect(branchRepeat.status).toBe(409);
    await store.createAssignment({
      id: "assignment-cleanup-active",
      workspaceId: workspace.id,
      taskId: "task-cleanup-active",
      threadId: thread.id,
      masterRunId: "run-master",
      workerAgentId: "agent-worker",
      repositoryId: repository.id,
      status: "running",
      branch: "nexestra/assignment-cleanup-active",
      worktreePath: `workspaces/${workspace.id}/worktrees/assignment-cleanup-active`,
      createdAt: now,
      updatedAt: now,
    });
    const active = await app.request("/api/assignments/assignment-cleanup-active/cleanup", {
      method: "POST",
    });
    expect(active.status).toBe(409);
    expect(cleanupAssignment).toHaveBeenCalledTimes(1);
    const activeBranch = await app.request("/api/assignments/assignment-cleanup-active/branch", {
      method: "POST",
    });
    expect(activeBranch.status).toBe(409);
    expect(deleteAssignmentBranch).toHaveBeenCalledTimes(1);
  });
  it("rejects configuration edits while an agent is busy and applies them afterwards", async () => {
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
    const blocked = await app.request(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Busy Editor" }),
    });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      error: { code: "conflict" },
    });
    releaseRunner();
    await app.dispatcher.waitForIdle();
    const updated = await app.request(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Edited Codex" }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ name: "Edited Codex" });
  });
  it("rejects unknown fields and kind changes when updating an agent", async () => {
    const agent = await store.createAgent({
      kind: "worker",
      name: "Codex",
      handle: "codex",
      description: "",
      instructions: "",
      harness: "codex",
    });
    for (const payload of [
      { name: "Changed", kind: "master" },
      { name: "Changed", workspaceId: "other-workspace" },
    ]) {
      const response = await app.request(`/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
    }
  });

  it("recovers a failed repository clone through the retry endpoint without changing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-app-retry-"));
    const retryStore = await FileStore.open({ root, workspacePath: root });
    const [workspace] = retryStore.listWorkspaces();
    if (!workspace) throw new Error("expected seeded workspace");
    const source = join(root, "docs-source");
    const failed = await retryStore.createKnowledgeRepository({
      name: "Docs repository",
      handle: "docs",
      description: "",
      source,
    });
    await retryStore.updateKnowledgeRepository(failed.id, {
      status: "failed",
      error: "The source was temporarily unavailable.",
    });
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "# Docs\n");
    await execFileAsync("git", ["init", "--initial-branch=main", source]);
    await execFileAsync("git", ["-C", source, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      source,
      "-c",
      "user.name=Nexestra Test",
      "-c",
      "user.email=test@nexestra.local",
      "commit",
      "-m",
      "Initial commit",
    ]);
    const retryApp = createApp({ store: retryStore, runner });

    const response = await retryApp.request(`/api/knowledge/repositories/${failed.id}/retry`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const recovered = (await response.json()) as {
      id: string;
      handle: string;
      source: string;
      status: string;
      createdAt: string;
      defaultBranch?: string;
    };
    expect(recovered).toMatchObject({
      id: failed.id,
      handle: "docs",
      source,
      status: "ready",
      defaultBranch: "main",
    });
    expect(recovered.createdAt).toBe(failed.createdAt);
    await expect(
      readFile(join(retryStore.knowledgePath(failed), "README.md"), "utf8"),
    ).resolves.toContain("# Docs");

    const repeat = await retryApp.request(`/api/knowledge/repositories/${failed.id}/retry`, {
      method: "POST",
    });
    expect(repeat.status).toBe(409);
    const missing = await retryApp.request("/api/knowledge/repositories/unknown/retry", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
  });
});
