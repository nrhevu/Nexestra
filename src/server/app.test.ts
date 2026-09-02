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
  gate?: Promise<void>;

  async runtimeStatus() {
    return runtime;
  }

  async invoke(agent: Agent, _invocation: AgentInvocation) {
    this.invocations += 1;
    await this.gate;
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

  it("rejects mutating browser requests from a non-loopback origin", async () => {
    const response = await app.request("/api/threads", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ name: "blocked" }),
    });
    expect(response.status).toBe(403);
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
