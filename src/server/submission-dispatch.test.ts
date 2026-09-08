import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRun, RuntimeStatus } from "../shared/contracts.js";
import { createApp } from "./app.js";
import { AgentDispatcher, ChatService } from "./dispatcher.js";
import type { AgentInvocation, AgentRunner } from "./runtime.js";
import { FileStore } from "./store.js";

const readyRuntime: RuntimeStatus = {
  chatgpt: { installed: true, connected: true, message: "ready" },
  harnesses: {
    codex: { installed: true, version: "test" },
    opencode: { installed: true, version: "test" },
  },
};

const uuidA = "3f0f8f1a-1111-4a11-8111-111111111111";
const uuidB = "3f0f8f1a-2222-4a22-8222-222222222222";
const uuidC = "3f0f8f1a-3333-4a33-8333-333333333333";
const uuidD = "3f0f8f1a-4444-4a44-8444-444444444444";
const uuidE = "3f0f8f1a-5555-4a55-8555-555555555555";
const uuidF = "3f0f8f1a-6666-4a66-8666-666666666666";
const uuidG = "3f0f8f1a-7777-4a77-8777-777777777777";
const uuidH = "3f0f8f1a-8888-4a88-8888-888888888888";
const uuidI = "3f0f8f1a-9999-4a99-8999-999999999999";
const uuidJ = "3f0f8f1a-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const uuidK = "3f0f8f1a-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uuidL = "3f0f8f1a-cccc-4ccc-8ccc-cccccccccccc";
const uuidM = "3f0f8f1a-dddd-4ddd-8ddd-dddddddddddd";
const uuidN = "3f0f8f1a-eeee-4eee-8eee-eeeeeeeeeeee";

class RecordingRunner implements AgentRunner {
  invocations: { agentId: string; runId?: string }[] = [];
  private gate: Promise<void> | undefined;
  private releaseGate: (() => void) | undefined;
  private started = false;
  private readonly startedWaiters: (() => void)[] = [];

  async runtimeStatus(): Promise<RuntimeStatus> {
    return readyRuntime;
  }

  blockNext(): void {
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  release(): void {
    this.releaseGate?.();
    this.releaseGate = undefined;
  }

  nextStarted(): Promise<void> {
    if (this.started) return Promise.resolve();
    return new Promise<void>((resolve) => this.startedWaiters.push(resolve));
  }

  async invoke(agent: Agent, invocation: AgentInvocation): Promise<string> {
    this.invocations.push({ agentId: agent.id, runId: invocation.runId });
    this.started = true;
    for (const resolve of this.startedWaiters.splice(0)) resolve();
    if (this.gate) await this.gate;
    return `reply from ${agent.handle}`;
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-submission-"));
  const store = await FileStore.open({ root, workspacePath: root });
  const runner = new RecordingRunner();
  const dispatcher = new AgentDispatcher(store, runner);
  const chat = new ChatService(store, dispatcher);
  const [thread] = store.listThreads();
  if (!thread) throw new Error("expected seeded thread");
  return { root, store, runner, dispatcher, chat, thread };
}

async function httpSetup() {
  const root = await mkdtemp(join(tmpdir(), "nexestra-submission-http-"));
  const store = await FileStore.open({ root, workspacePath: root });
  const runner = new RecordingRunner();
  const app = createApp({ store, runner });
  const [thread] = store.listThreads();
  if (!thread) throw new Error("expected seeded thread");
  return { root, store, runner, app, thread };
}

async function createAgent(store: FileStore, handle: string): Promise<Agent> {
  const [workspace] = store.listWorkspaces();
  if (!workspace) throw new Error("expected seeded workspace");
  return store.createAgent({
    workspaceId: workspace.id,
    kind: "worker",
    name: handle,
    handle,
    description: "",
    instructions: "",
    harness: "codex",
  });
}

async function userMessages(store: FileStore, threadId: string) {
  const data = await store.threadData(threadId);
  return data.messages.filter((message) => message.author.kind === "user");
}

function messageUrl(threadId: string): string {
  return `/api/threads/${threadId}/messages`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("recoverable submission dispatch", () => {
  it("returns 201 for a new keyed send and 200 replay without duplicating dispatch", async () => {
    const { store, runner, app, thread } = await httpSetup();
    const codex = await createAgent(store, "codex");
    const body = { content: "@codex hello", requestId: uuidA };

    const first = await app.request(messageUrl(thread.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as {
      message: { id: string };
      runs: { id: string }[];
      replayed?: boolean;
    };
    expect(firstJson.replayed).toBeUndefined();

    const second = await app.request(messageUrl(thread.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as {
      message: { id: string };
      runs: { id: string }[];
      replayed?: boolean;
    };
    expect(secondJson.replayed).toBe(true);
    expect(secondJson.message.id).toBe(firstJson.message.id);
    expect(secondJson.runs.map((run) => run.id)).toEqual(firstJson.runs.map((run) => run.id));
    await app.dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(1);
    expect(await userMessages(store, thread.id)).toHaveLength(1);
    expect(codex.id).toBeDefined();
  });

  it("recovers a lost response after message persistence via the same key", async () => {
    const { store, runner, app, thread } = await httpSetup();
    await createAgent(store, "codex");
    const body = { content: "@codex recover me", requestId: uuidB };

    const spy = vi
      .spyOn(app.dispatcher, "enqueue")
      .mockRejectedValueOnce(new Error("response lost"));
    const failed = await app.request(messageUrl(thread.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(failed.status).toBe(500);
    spy.mockRestore();

    const retry = await app.request(messageUrl(thread.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(retry.status).toBe(200);
    const retryJson = (await retry.json()) as { message: { id: string }; replayed?: boolean };
    expect(retryJson.replayed).toBe(true);
    await app.dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(1);
    expect(await userMessages(store, thread.id)).toHaveLength(1);
  });

  it("deduplicates simultaneous same-key submissions to one message and one run", async () => {
    const { store, runner, dispatcher, chat, thread } = await setup();
    await createAgent(store, "codex");
    const body = { content: "@codex race", requestId: uuidC };
    runner.blockNext();

    const firstPromise = chat.send(thread.id, body);
    await runner.nextStarted();
    const secondPromise = chat.send(thread.id, body);
    const second = await secondPromise;
    const first = await firstPromise;

    expect(first.message.id).toBe(second.message.id);
    expect(first.runs.map((run) => run.id)).toEqual(second.runs.map((run) => run.id));
    expect(first.runs).toHaveLength(1);
    runner.release();
    await dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(1);
    expect(await userMessages(store, thread.id)).toHaveLength(1);
  });

  it("rejects a different payload with the same in-flight key", async () => {
    const { store, runner, chat, thread } = await setup();
    await createAgent(store, "codex");
    runner.blockNext();

    const firstPromise = chat.send(thread.id, { content: "@codex original", requestId: uuidD });
    await runner.nextStarted();
    await expect(
      chat.send(thread.id, { content: "@codex changed", requestId: uuidD }),
    ).rejects.toMatchObject({ code: "conflict" });
    runner.release();
    await firstPromise;
    expect(await userMessages(store, thread.id)).toHaveLength(1);
  });

  it("rejects a different payload with the same completed key", async () => {
    const { store, runner, dispatcher, chat, thread } = await setup();
    await createAgent(store, "codex");
    await chat.send(thread.id, { content: "@codex original", requestId: uuidE });
    await dispatcher.waitForIdle();
    await expect(
      chat.send(thread.id, { content: "@codex changed", requestId: uuidE }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await userMessages(store, thread.id)).toHaveLength(1);
    expect(runner.invocations).toHaveLength(1);
  });

  it("rejects invalid or duplicated multipart request ids with 400", async () => {
    const { app, thread } = await httpSetup();
    const duplicate = new FormData();
    duplicate.append("content", "note");
    duplicate.append("requestId", uuidF);
    duplicate.append("requestId", uuidG);
    const duplicateResponse = await app.request(messageUrl(thread.id), {
      method: "POST",
      body: duplicate,
    });
    expect(duplicateResponse.status).toBe(400);

    const invalid = new FormData();
    invalid.append("content", "note");
    invalid.append("requestId", "not-a-uuid");
    const invalidResponse = await app.request(messageUrl(thread.id), {
      method: "POST",
      body: invalid,
    });
    expect(invalidResponse.status).toBe(400);
  });

  it("reads requestId from multipart and replays the same attachment submission", async () => {
    const { store, runner, app, thread } = await httpSetup();
    await createAgent(store, "codex");
    const form = new FormData();
    form.append("content", "@codex inspect file");
    form.append("requestId", uuidM);
    form.append("files", new File(["hello"], "hello.txt", { type: "text/plain" }));

    const first = await app.request(messageUrl(thread.id), { method: "POST", body: form });
    expect(first.status).toBe(201);
    const second = await app.request(messageUrl(thread.id), { method: "POST", body: form });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as { replayed?: boolean };
    expect(secondJson.replayed).toBe(true);
    await app.dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(1);
    const data = await store.threadData(thread.id);
    expect(data.messages.filter((message) => message.author.kind === "user")).toHaveLength(1);
    expect(data.artifacts).toHaveLength(1);
  });

  it("reuses the same durable queued run id when no live entry exists", async () => {
    const { store, runner, dispatcher, thread } = await setup();
    const codex = await createAgent(store, "codex");
    const requestId = uuidH;
    const message = await store.createUserMessage(
      thread.id,
      "@codex resume",
      [{ agentId: codex.id, handle: codex.handle }],
      [],
      [],
      requestId,
    );
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: "durable-queued-run",
      threadId: thread.id,
      triggerMessageId: message.id,
      agentId: codex.id,
      attempt: 1,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    expect(dispatcher.reconcileQueuedRun(run, codex, message)).toBe(true);
    expect(dispatcher.liveRunExists(run.id)).toBe(true);
    await dispatcher.waitForIdle();
    expect(runner.invocations.some((entry) => entry.runId === run.id)).toBe(true);
    const data = await store.threadData(thread.id);
    expect(data.runs.filter((entry) => entry.id === run.id)).toHaveLength(1);
    expect(data.runs.find((entry) => entry.id === run.id)?.status).toBe("completed");
  });

  it("enqueues only the missing original mention after a partial multi-agent failure", async () => {
    const { store, runner, dispatcher, chat, thread } = await setup();
    const alpha = await createAgent(store, "alpha");
    const beta = await createAgent(store, "beta");
    const requestId = uuidI;
    const originalUpdateRun = store.updateRun.bind(store);
    const spy = vi.spyOn(store, "updateRun");
    spy.mockImplementation(async (run: AgentRun) => {
      if (run.agentId === beta.id && run.status === "queued") {
        throw new Error("beta queued run write failed");
      }
      return originalUpdateRun(run);
    });
    await expect(chat.send(thread.id, { content: "@alpha @beta both", requestId })).rejects.toThrow(
      "beta queued run write failed",
    );
    spy.mockRestore();

    const before = await store.threadData(thread.id);
    const message = before.messages.find((entry) => entry.author.kind === "user");
    if (!message) throw new Error("expected persisted user message");
    const runsBefore = before.runs.filter((run) => run.triggerMessageId === message.id);
    expect(runsBefore.map((run) => run.agentId).sort()).toEqual([alpha.id]);

    const retried = await chat.send(thread.id, { content: "@alpha @beta both", requestId });
    expect(retried.replayed).toBe(true);
    await dispatcher.waitForIdle();
    const after = await store.threadData(thread.id);
    const runsAfter = after.runs.filter((run) => run.triggerMessageId === retried.message.id);
    expect(runsAfter.map((run) => run.agentId).sort()).toEqual([alpha.id, beta.id].sort());
    expect(runner.invocations.map((entry) => entry.agentId).sort()).toEqual(
      [alpha.id, beta.id].sort(),
    );
    expect(await userMessages(store, thread.id)).toHaveLength(1);
  });

  it("does not auto-run an interrupted run after restart and keeps explicit run retry", async () => {
    const { store, thread } = await setup();
    const codex = await createAgent(store, "codex");
    const requestId = uuidJ;
    const stored = await store.createUserMessage(
      thread.id,
      "@codex restart me",
      [{ agentId: codex.id, handle: codex.handle }],
      [],
      [],
      requestId,
    );
    const now = new Date().toISOString();
    const runId = "durable-queued-restart";
    await store.updateRun({
      id: runId,
      threadId: thread.id,
      triggerMessageId: stored.id,
      agentId: codex.id,
      attempt: 1,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });

    const reopened = await FileStore.open({ root: store.root, workspacePath: store.workspacePath });
    const runner = new RecordingRunner();
    const dispatcher = new AgentDispatcher(reopened, runner);
    const chat = new ChatService(reopened, dispatcher);
    const result = await chat.send(thread.id, { content: "@codex restart me", requestId });
    expect(result.replayed).toBe(true);
    expect(runner.invocations).toHaveLength(0);
    const data = await reopened.threadData(thread.id);
    expect(data.runs.find((run) => run.id === runId)?.status).toBe("interrupted");

    const retried = await dispatcher.retry(runId);
    expect(retried.id).not.toBe(runId);
    expect(retried.attempt).toBe(2);
    await dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(1);
    expect(await userMessages(reopened, thread.id)).toHaveLength(1);
  });

  it("confirms an archived replay without dispatch side effects", async () => {
    const { store, runner, dispatcher, chat, thread } = await setup();
    const codex = await createAgent(store, "codex");
    const requestId = uuidK;
    await store.createUserMessage(
      thread.id,
      "@codex archive me",
      [{ agentId: codex.id, handle: codex.handle }],
      [],
      [],
      requestId,
    );
    await dispatcher.archiveThread(thread.id);
    const result = await chat.send(thread.id, { content: "@codex archive me", requestId });
    expect(result.replayed).toBe(true);
    expect(result.runs).toHaveLength(0);
    await dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(0);
    expect(await userMessages(store, thread.id)).toHaveLength(1);
  });

  it("records failed runs for disabled or deleted original agents on replay", async () => {
    const { store, runner, dispatcher, chat, thread } = await setup();
    const codex = await createAgent(store, "codex");
    const requestId = uuidL;
    await store.createUserMessage(
      thread.id,
      "@codex disabled",
      [{ agentId: codex.id, handle: codex.handle }],
      [],
      [],
      requestId,
    );
    await store.updateAgent(codex.id, { enabled: false });
    const disabled = await chat.send(thread.id, { content: "@codex disabled", requestId });
    expect(disabled.replayed).toBe(true);
    expect(disabled.runs).toHaveLength(1);
    expect(disabled.runs[0]?.agentId).toBe(codex.id);
    expect(disabled.runs[0]?.status).toBe("failed");
    expect(disabled.runs[0]?.error).toMatch(/unavailable/i);
    expect(runner.invocations).toHaveLength(0);

    const delta = await createAgent(store, "delta");
    const deletedRequestId = uuidF;
    const stored = await store.createUserMessage(
      thread.id,
      "@delta deleted",
      [{ agentId: delta.id, handle: delta.handle }],
      [],
      [],
      deletedRequestId,
    );
    await store.deleteAgent(delta.id);
    const deleted = await chat.send(thread.id, {
      content: "@delta deleted",
      requestId: deletedRequestId,
    });
    expect(stored.id).toBeDefined();
    expect(deleted.replayed).toBe(true);
    expect(deleted.runs).toHaveLength(1);
    expect(deleted.runs[0]?.agentId).toBe(delta.id);
    expect(deleted.runs[0]?.status).toBe("failed");
    expect(deleted.runs[0]?.triggerMessageId).toBe(stored.id);
    await dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(0);
  });

  it("marks a durable queued run failed without creating a new run when the agent is unavailable", async () => {
    const { store, runner, dispatcher, chat, thread } = await setup();
    const codex = await createAgent(store, "codex");
    const requestId = uuidN;
    const message = await store.createUserMessage(
      thread.id,
      "@codex unavailable",
      [{ agentId: codex.id, handle: codex.handle }],
      [],
      [],
      requestId,
    );
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: "durable-disabled-run",
      threadId: thread.id,
      triggerMessageId: message.id,
      agentId: codex.id,
      attempt: 1,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    await store.updateRun(run);
    await store.updateAgent(codex.id, { enabled: false });
    const replayed = await chat.send(thread.id, { content: "@codex unavailable", requestId });
    expect(replayed.replayed).toBe(true);
    expect(replayed.runs).toHaveLength(1);
    expect(replayed.runs[0]?.id).toBe(run.id);
    expect(replayed.runs[0]?.agentId).toBe(codex.id);
    expect(replayed.runs[0]?.status).toBe("failed");
    expect(replayed.runs[0]?.error).toMatch(/unavailable/i);
    await dispatcher.waitForIdle();
    expect(runner.invocations).toHaveLength(0);
    const data = await store.threadData(thread.id);
    const storedRun = data.runs.find((entry) => entry.id === run.id);
    expect(storedRun?.status).toBe("failed");
    expect(data.runs.filter((entry) => entry.triggerMessageId === message.id)).toHaveLength(1);
  });

  it("keeps legacy unkeyed sends independent for identical text", async () => {
    const { store, runner, dispatcher, chat, thread } = await setup();
    await createAgent(store, "codex");
    await chat.send(thread.id, { content: "@codex once" });
    await dispatcher.waitForIdle();
    await chat.send(thread.id, { content: "@codex once" });
    await dispatcher.waitForIdle();
    expect(await userMessages(store, thread.id)).toHaveLength(2);
    expect(runner.invocations).toHaveLength(2);
  });
});
