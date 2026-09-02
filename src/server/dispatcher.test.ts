import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, RuntimeStatus } from "../shared/contracts.js";
import { AgentDispatcher, ChatService } from "./dispatcher.js";
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
  it("persists ordinary chat without invoking an agent", async () => {
    const { chat, dispatcher, runner, store, thread } = await setup();
    await chat.send(thread.id, { content: "ghi chú không mention" });
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
      content: "@codex và @opencode xem giúp. @CODEX nhớ trả lời nhé.",
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

    const first = await chat.send(thread.id, { content: "@codex câu hỏi thứ nhất" });
    const second = await chat.send(thread.id, { content: "@codex câu hỏi thứ hai" });
    await dispatcher.waitForIdle();

    expect(runner.invocations.map(({ invocation }) => invocation.trigger.content)).toEqual([
      "@codex câu hỏi thứ nhất",
      "@codex câu hỏi thứ hai",
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
    await chat.send(thread.id, { content: "@codex bạn còn đó không?" });
    await dispatcher.waitForIdle();

    const [run] = (await store.threadData(thread.id)).runs;
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("Đã tắt");
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
    const trigger = await store.createUserMessage(thread.id, "@codex thử lại", [
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
});
