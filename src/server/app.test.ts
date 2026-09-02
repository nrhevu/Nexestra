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

  async runtimeStatus() {
    return runtime;
  }

  async invoke(agent: Agent, _invocation: AgentInvocation) {
    this.invocations += 1;
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
      }),
    });
    expect(agentResponse.status).toBe(201);
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

  it("keeps unknown API paths inside the JSON error namespace", async () => {
    const response = await app.request("/api");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
