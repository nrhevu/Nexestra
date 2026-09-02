import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  LocalAgentRunner,
  parseCodexReply,
  parseOpenCodeReply,
  parseProviderReply,
} from "./runtime.js";
import { FileStore } from "./store.js";

const processMocks = vi.hoisted(() => ({
  findExecutable: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("./process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./process.js")>();
  return {
    ...actual,
    findExecutable: processMocks.findExecutable,
    runCommand: processMocks.runCommand,
  };
});

describe("harness output parsers", () => {
  it("takes the last completed Codex agent message", () => {
    const output = [
      "not-json",
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final" } }),
    ].join("\n");
    expect(parseCodexReply(output)).toBe("final");
  });

  it("takes the last OpenCode text part", () => {
    const output = [
      JSON.stringify({ type: "text", part: { type: "text", text: "one" } }),
      JSON.stringify({ type: "step_finish", part: {} }),
      JSON.stringify({ type: "text", part: { type: "text", text: "two" } }),
    ].join("\n");
    expect(parseOpenCodeReply(output)).toBe("two");
  });
});

describe("Worker harness arguments", () => {
  beforeEach(() => {
    processMocks.findExecutable.mockReset();
    processMocks.runCommand.mockReset();
  });

  it("passes model and reasoning effort to Codex", async () => {
    const { agent, invocation, root, runner } = await workerFixture("codex", "gpt-5.4", "high");
    processMocks.findExecutable.mockResolvedValue("/fake/codex");
    processMocks.runCommand.mockResolvedValue({
      stdout: JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      stderr: "",
      exitCode: 0,
    });

    await expect(runner.invoke(agent, invocation)).resolves.toBe("Done.");
    const [command, args] = processMocks.runCommand.mock.calls[0] ?? [];
    expect(command).toBe("/fake/codex");
    expect(args).toEqual([
      "exec",
      "--json",
      "-C",
      root,
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "-o",
      expect.stringContaining(join(root, "runs")),
      "-m",
      "gpt-5.4",
      "-c",
      'model_reasoning_effort="high"',
      expect.stringContaining("@codex"),
    ]);
  });

  it("passes model and reasoning effort to OpenCode", async () => {
    const { agent, invocation, root, runner } = await workerFixture(
      "opencode",
      "anthropic/claude-sonnet-4",
      "high",
    );
    processMocks.findExecutable.mockResolvedValue("/fake/opencode");
    processMocks.runCommand.mockResolvedValue({
      stdout: JSON.stringify({ type: "text", part: { type: "text", text: "Done." } }),
      stderr: "",
      exitCode: 0,
    });

    await expect(runner.invoke(agent, invocation)).resolves.toBe("Done.");
    const [command, args] = processMocks.runCommand.mock.calls[0] ?? [];
    expect(command).toBe("/fake/opencode");
    expect(args).toEqual([
      "run",
      "--format",
      "json",
      "--pure",
      "--agent",
      "plan",
      "--dir",
      root,
      "-m",
      "anthropic/claude-sonnet-4",
      "--variant",
      "high",
      "--file",
      invocation.transcriptPath,
      "--",
      expect.stringContaining("@opencode"),
    ]);
  });

  it.each(["codex", "opencode"] as const)(
    "keeps the %s defaults when no overrides are configured",
    async (harness) => {
      const { agent, invocation, runner } = await workerFixture(harness);
      processMocks.findExecutable.mockResolvedValue(`/fake/${harness}`);
      processMocks.runCommand.mockResolvedValue({
        stdout:
          harness === "codex"
            ? JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: "Done." },
              })
            : JSON.stringify({ type: "text", part: { type: "text", text: "Done." } }),
        stderr: "",
        exitCode: 0,
      });

      await expect(runner.invoke(agent, invocation)).resolves.toBe("Done.");
      const args = processMocks.runCommand.mock.calls[0]?.[1] ?? [];
      expect(args).not.toContain("-m");
      expect(args).not.toContain("-c");
      expect(args).not.toContain("--variant");
    },
  );
});

describe("parseProviderReply", () => {
  it("supports chat completions and responses payloads", () => {
    expect(parseProviderReply({ choices: [{ message: { content: "hello" } }] })).toBe("hello");
    expect(parseProviderReply({ output_text: "world" })).toBe("world");
  });

  it("sends a shared transcript to a custom provider without exposing its key elsewhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "nexestra-provider-"));
    const store = await FileStore.open({ root, workspacePath: root });
    const created = await store.createAgent({
      kind: "master",
      name: "Maya",
      handle: "maya",
      description: "",
      instructions: "Keep it concise.",
      provider: {
        type: "custom",
        name: "Gateway",
        baseUrl: "https://gateway.example/v1",
        model: "model-a",
        protocol: "openai-chat",
        apiKey: "secret-key",
      },
    });
    if (created.kind !== "master") throw new Error("expected master agent");
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ choices: [{ message: { content: "Understood." } }] }), {
          status: 200,
        }),
    );
    const runner = new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const trigger = await store.createUserMessage(thread.id, "@maya make a plan", [
      { agentId: created.id, handle: created.handle },
    ]);
    await store.createUserMessage(thread.id, "a newer message must not change the target", []);

    const reply = await runner.invoke(created, {
      thread,
      trigger,
      transcriptPath: store.transcriptPath(thread.id),
      transcriptSnapshot: await store.transcriptSnapshot(thread.id),
    });

    expect(reply).toBe("Understood.");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    if (!init) throw new Error("expected request init");
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(String(init.body)).toContain("@maya make a plan");
    expect(String(init.body)).toContain(`Required message to answer (id: ${trigger.id})`);
    expect(String(init.body)).toContain("even if the transcript contains newer messages");

    const oversizedRunner = new LocalAgentRunner({
      store,
      fetch: (async () =>
        new Response("oversized", {
          status: 200,
          headers: { "content-length": String(1024 * 1024 + 1) },
        })) as typeof fetch,
    });
    await expect(
      oversizedRunner.invoke(created, {
        thread,
        trigger,
        transcriptPath: store.transcriptPath(thread.id),
        transcriptSnapshot: await store.transcriptSnapshot(thread.id),
      }),
    ).rejects.toThrow("too much data");
  });
});

async function workerFixture(
  harness: "codex" | "opencode",
  model?: string,
  reasoningEffort?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "nexestra-worker-runtime-"));
  const store = await FileStore.open({ root, workspacePath: root });
  const agent = await store.createAgent({
    kind: "worker",
    name: harness === "codex" ? "Codex" : "OpenCode",
    handle: harness,
    description: "",
    instructions: "",
    harness,
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  });
  if (agent.kind !== "worker") throw new Error("expected worker agent");
  const [thread] = store.listThreads();
  if (!thread) throw new Error("expected seeded thread");
  const trigger = await store.createUserMessage(thread.id, `@${agent.handle} reply`, [
    { agentId: agent.id, handle: agent.handle },
  ]);
  return {
    agent,
    root,
    runner: new LocalAgentRunner({ store }),
    invocation: {
      thread,
      trigger,
      transcriptPath: store.transcriptPath(thread.id),
      transcriptSnapshot: await store.transcriptSnapshot(thread.id),
    },
  };
}
