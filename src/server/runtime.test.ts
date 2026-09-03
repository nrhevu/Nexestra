import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterAccessMode } from "../shared/contracts.js";
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

describe("Runtime status cache", () => {
  it("reuses binary and login detection for thirty seconds", async () => {
    vi.useFakeTimers();
    try {
      processMocks.findExecutable.mockReset();
      processMocks.runCommand.mockReset();
      processMocks.findExecutable.mockResolvedValue(undefined);
      const root = await mkdtemp(join(tmpdir(), "nexestra-runtime-cache-"));
      const store = await FileStore.open({ root, workspacePath: root });
      const runner = new LocalAgentRunner({ store });

      await runner.runtimeStatus();
      vi.advanceTimersByTime(29_000);
      await runner.runtimeStatus();
      expect(processMocks.findExecutable).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(2_000);
      await runner.runtimeStatus();
      expect(processMocks.findExecutable).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
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

  it.each(["codex", "opencode"] as const)(
    "attaches triggering message files to %s",
    async (harness) => {
      const { agent, invocation, runner } = await workerFixture(
        harness,
        undefined,
        undefined,
        true,
      );
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

      await runner.invoke(agent, invocation);
      const args = processMocks.runCommand.mock.calls[0]?.[1] ?? [];
      const imagePath = invocation.artifacts?.[0]?.localPath;
      expect(imagePath).toBeTruthy();
      expect(args).toContain(imagePath);
      expect(args).toContain(harness === "codex" ? "--image" : "--file");
    },
  );
});

describe("ChatGPT Master harness arguments", () => {
  it.each([
    ["ask", "read-only", false, false],
    ["auto", "workspace-write", true, false],
    ["full", undefined, false, true],
  ] as const)(
    "maps %s access to the expected Codex sandbox and approval flags",
    async (accessMode, sandbox, autoApprove, bypass) => {
      processMocks.findExecutable.mockReset();
      processMocks.runCommand.mockReset();
      const root = await mkdtemp(join(tmpdir(), "nexestra-master-codex-"));
      const store = await FileStore.open({ root: join(root, ".nexestra"), workspacePath: root });
      const agent = await store.createAgent({
        kind: "master",
        name: "Builder",
        handle: "builder",
        description: "",
        instructions: "",
        accessMode,
        provider: { type: "chatgpt", model: "" },
      });
      const [thread] = store.listThreads();
      if (!thread) throw new Error("expected seeded thread");
      const trigger = await store.createUserMessage(thread.id, "@builder update the code", [
        { agentId: agent.id, handle: agent.handle },
      ]);
      processMocks.findExecutable.mockResolvedValue("/fake/codex");
      processMocks.runCommand.mockResolvedValue({
        stdout: JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Done." },
        }),
        stderr: "",
        exitCode: 0,
      });

      await new LocalAgentRunner({ store }).invoke(agent, {
        thread,
        trigger,
        transcriptPath: store.transcriptPath(thread.id),
        transcriptSnapshot: await store.transcriptSnapshot(thread.id),
      });

      const args = processMocks.runCommand.mock.calls[0]?.[1] ?? [];
      if (sandbox) expect(args).toContain(sandbox);
      else expect(args).not.toContain("-s");
      expect(args.includes("--approve-for-me")).toBe(autoApprove);
      expect(args.includes("--dangerously-bypass-approvals-and-sandbox")).toBe(bypass);
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
        new Response(
          JSON.stringify({ choices: [{ message: { content: "secret-key must not leak" } }] }),
          { status: 200 },
        ),
    );
    const runner = new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const trigger = await store.createUserMessage(
      thread.id,
      "@maya make a plan",
      [{ agentId: created.id, handle: created.handle }],
      [
        {
          name: "plan.png",
          mediaType: "image/png",
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
      ],
    );
    await store.createUserMessage(thread.id, "a newer message must not change the target", []);

    const reply = await runner.invoke(created, {
      thread,
      trigger,
      transcriptPath: store.transcriptPath(thread.id),
      transcriptSnapshot: await store.transcriptSnapshot(thread.id),
      artifacts: await store.agentArtifacts(thread.id, trigger.id),
    });

    expect(reply).toBe("[REDACTED] must not leak");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    if (!init) throw new Error("expected request init");
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(String(init.body)).toContain("@maya make a plan");
    expect(String(init.body)).toContain(`Required message to answer (id: ${trigger.id})`);
    expect(String(init.body)).toContain("even if the transcript contains newer messages");
    expect(String(init.body)).toContain("data:image/png;base64,");

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

  it("lets Chat Completions read an artifact attached to the triggering message", async () => {
    const { agent, invocation, store } = await customMasterFixture("openai-chat", "full", true);
    const artifactPath = invocation.artifacts[0]?.localPath;
    if (!artifactPath) throw new Error("expected attached artifact path");
    const responses = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-read",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: artifactPath }) },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "The answer is forty two." } }] },
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(responses.shift())),
    );
    const reply = await new LocalAgentRunner({
      store,
      fetch: fetchMock as typeof fetch,
    }).invoke(agent, invocation);

    expect(reply).toBe("The answer is forty two.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(
      firstBody.tools.map((tool: { function: { name: string } }) => tool.function.name),
    ).toEqual([
      "list",
      "glob",
      "grep",
      "read",
      "edit",
      "write",
      "bash",
      "apply_patch",
      "skill",
      "todowrite",
      "webfetch",
      "websearch",
      "question",
    ]);
    expect(secondBody.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-read",
        content: expect.stringContaining("forty two"),
      }),
    );
  });

  it("executes Responses function calls and feeds function_call_output into the next turn", async () => {
    const { agent, invocation, root, store } = await customMasterFixture(
      "openai-responses",
      "full",
    );
    const responses = [
      {
        output: [
          {
            type: "function_call",
            call_id: "call-write",
            name: "write",
            arguments: '{"path":"generated.txt","content":"created by harness\\n"}',
          },
        ],
      },
      { output_text: "Created generated.txt." },
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(responses.shift())),
    );
    const reply = await new LocalAgentRunner({
      store,
      fetch: fetchMock as typeof fetch,
    }).invoke(agent, invocation);

    expect(reply).toBe("Created generated.txt.");
    expect(await readFile(join(root, "generated.txt"), "utf8")).toBe("created by harness\n");
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-write",
      output: expect.stringContaining("Wrote generated.txt"),
    });
  });

  it("stops three identical provider tool calls instead of looping forever", async () => {
    const { agent, invocation, root, store } = await customMasterFixture("openai-chat");
    await writeFile(join(root, "loop.txt"), "loop\n");
    let callNumber = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${++callNumber}`,
                      type: "function",
                      function: { name: "read", arguments: '{"path":"loop.txt"}' },
                    },
                  ],
                },
              },
            ],
          }),
        ),
    );

    await expect(
      new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, invocation),
    ).rejects.toThrow("Stopped a repeated read tool-call loop");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

async function customMasterFixture(
  protocol: "openai-chat" | "openai-responses",
  accessMode: MasterAccessMode = "full",
  attachText = false,
) {
  const root = await mkdtemp(join(tmpdir(), "nexestra-provider-tools-"));
  const store = await FileStore.open({ root: join(root, ".nexestra"), workspacePath: root });
  const agent = await store.createAgent({
    kind: "master",
    name: "Maya",
    handle: "maya",
    description: "",
    instructions: "",
    accessMode,
    provider: {
      type: "custom",
      name: "Gateway",
      baseUrl: "https://gateway.example/v1",
      model: "model-a",
      protocol,
    },
  });
  if (agent.kind !== "master") throw new Error("expected master agent");
  const [thread] = store.listThreads();
  if (!thread) throw new Error("expected seeded thread");
  const trigger = await store.createUserMessage(
    thread.id,
    "@maya do the work",
    [{ agentId: agent.id, handle: agent.handle }],
    attachText
      ? [
          {
            name: "answer.txt",
            mediaType: "text/plain",
            bytes: new TextEncoder().encode("forty two\n"),
          },
        ]
      : [],
  );
  return {
    agent,
    root,
    store,
    invocation: {
      runId: "run-tools",
      thread,
      trigger,
      transcriptPath: store.transcriptPath(thread.id),
      transcriptSnapshot: await store.transcriptSnapshot(thread.id),
      artifacts: await store.agentArtifacts(thread.id, trigger.id),
    },
  };
}

async function workerFixture(
  harness: "codex" | "opencode",
  model?: string,
  reasoningEffort?: string,
  attachImage = false,
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
  const trigger = await store.createUserMessage(
    thread.id,
    `@${agent.handle} reply`,
    [{ agentId: agent.id, handle: agent.handle }],
    attachImage
      ? [
          {
            name: "context.png",
            mediaType: "image/png",
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          },
        ]
      : [],
  );
  return {
    agent,
    root,
    runner: new LocalAgentRunner({ store }),
    invocation: {
      thread,
      trigger,
      transcriptPath: store.transcriptPath(thread.id),
      transcriptSnapshot: await store.transcriptSnapshot(thread.id),
      artifacts: await store.agentArtifacts(thread.id, trigger.id),
    },
  };
}
