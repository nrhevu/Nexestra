import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterAccessMode } from "../shared/contracts.js";
import type { AgentInvocation, RuntimeToolUpdate } from "./runtime.js";
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
      "--thinking",
      "--file",
      invocation.transcriptPath,
      "--",
      expect.stringContaining("@opencode"),
    ]);
  });

  it.each(["codex", "opencode"] as const)(
    "runs a delegated %s Worker with write access inside its assignment worktree",
    async (harness) => {
      const { agent, invocation, root, runner } = await workerFixture(harness);
      const worktree = join(root, "managed-worktree");
      invocation.mode = "task";
      invocation.workingDirectory = worktree;
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

      const [, args, options] = processMocks.runCommand.mock.calls[0] ?? [];
      expect(options).toMatchObject({ cwd: worktree });
      if (harness === "codex") {
        expect(args).toEqual(expect.arrayContaining(["-C", worktree, "--approve-for-me"]));
        expect(args).not.toContain("-s");
      } else {
        expect(args).toEqual(expect.arrayContaining(["--agent", "build", "--dir", worktree]));
      }
    },
  );

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

  it("forwards split Codex JSONL tool and response events while the command runs", async () => {
    const { agent, invocation, runner } = await workerFixture("codex");
    const tool = vi.fn(async (_update: RuntimeToolUpdate) => undefined);
    const thinking = vi.fn();
    const text = vi.fn();
    const output = [
      JSON.stringify({
        type: "item.completed",
        item: { id: "reasoning-1", type: "reasoning", text: "Inspecting the workspace." },
      }),
      JSON.stringify({
        type: "item.started",
        item: { id: "item-1", type: "command_execution", command: "pwd", status: "in_progress" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          command: "pwd",
          status: "completed",
          aggregated_output: "/workspace",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
    ].join("\n");
    processMocks.findExecutable.mockResolvedValue("/fake/codex");
    processMocks.runCommand.mockImplementation(
      async (
        _command: string,
        _args: string[],
        options: { onStdout?: (chunk: string) => void },
      ) => {
        options.onStdout?.(output.slice(0, 37));
        options.onStdout?.(output.slice(37));
        return { stdout: output, stderr: "", exitCode: 0 };
      },
    );

    await expect(
      runner.invoke(agent, {
        ...invocation,
        activityHooks: { status: vi.fn(), thinking, text, tool },
      }),
    ).resolves.toBe("Done.");
    expect(thinking).toHaveBeenCalledWith("Inspecting the workspace.\n\n", "append");
    expect(text).toHaveBeenCalledWith("Done.", "replace");
    expect(tool.mock.calls.map(([update]) => update.status)).toEqual(["running", "completed"]);
    expect(tool).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "bash", input: '{"command":"pwd"}' }),
    );
  });

  it("forwards OpenCode tool and text events while the command runs", async () => {
    const { agent, invocation, runner } = await workerFixture("opencode");
    const tool = vi.fn(async (_update: RuntimeToolUpdate) => undefined);
    const thinking = vi.fn();
    const text = vi.fn();
    const output = [
      JSON.stringify({
        type: "reasoning",
        part: { type: "reasoning", text: "Checking the relevant file." },
      }),
      JSON.stringify({
        type: "tool_use",
        part: {
          id: "part-1",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: { filePath: "README.md" }, title: "Read README.md" },
        },
      }),
      JSON.stringify({ type: "text", part: { type: "text", text: "Done." } }),
    ].join("\n");
    processMocks.findExecutable.mockResolvedValue("/fake/opencode");
    processMocks.runCommand.mockImplementation(
      async (
        _command: string,
        _args: string[],
        options: { onStdout?: (chunk: string) => void },
      ) => {
        options.onStdout?.(output);
        return { stdout: output, stderr: "", exitCode: 0 };
      },
    );

    await expect(
      runner.invoke(agent, {
        ...invocation,
        activityHooks: { status: vi.fn(), thinking, text, tool },
      }),
    ).resolves.toBe("Done.");
    expect(thinking).toHaveBeenCalledWith("Checking the relevant file.\n\n", "append");
    expect(text).toHaveBeenCalledWith("Done.", "replace");
    expect(tool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "read", status: "completed", permission: "read" }),
    );
  });
});

describe("ChatGPT Master harness arguments", () => {
  it.each([
    ["ask", "read-only", false, false],
    ["auto", undefined, true, false],
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

  it("streams Chat Completions text deltas while preserving the final reply", async () => {
    const { agent, invocation, store } = await customMasterFixture("openai-chat");
    const thinking = vi.fn();
    const text = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      sseResponse([
        { choices: [{ delta: { reasoning_content: "Considering the request. " } }] },
        { choices: [{ delta: { reasoning_content: "Preparing the answer." } }] },
        { choices: [{ delta: { reasoning: " Verifying details." } }] },
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " from the stream." }, finish_reason: "stop" }] },
      ]),
    );

    await expect(
      new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, {
        ...invocation,
        activityHooks: {
          status: vi.fn(),
          thinking,
          text,
          tool: vi.fn(async () => undefined),
        },
      }),
    ).resolves.toBe("Hello from the stream.");
    expect(text.mock.calls).toEqual([
      ["Hello", "append"],
      [" from the stream.", "append"],
    ]);
    expect(thinking.mock.calls).toEqual([
      ["Considering the request. ", "append"],
      ["Preparing the answer.", "append"],
      [" Verifying details.", "append"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ stream: true });
  });

  it("assembles fragmented streamed Chat Completions tool calls", async () => {
    const { agent, invocation, root, store } = await customMasterFixture("openai-chat");
    await writeFile(join(root, "stream.txt"), "streamed tool result\n");
    const responses = [
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-read",
                    function: { name: "re", arguments: '{"file' },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { name: "ad", arguments: 'Path":"stream.txt"}' },
                  },
                ],
              },
            },
          ],
        },
      ]),
      sseResponse([{ choices: [{ delta: { content: "Read the streamed file." } }] }]),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift() ?? new Response("missing", { status: 500 }),
    );

    await expect(
      new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, invocation),
    ).resolves.toBe("Read the streamed file.");
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call-read",
        content: expect.stringContaining("streamed tool result"),
      }),
    );
  });

  it("streams Responses API text deltas and accepts the completed response", async () => {
    const { agent, invocation, store } = await customMasterFixture("openai-responses");
    const thinking = vi.fn();
    const text = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      sseResponse([
        { type: "response.reasoning_summary_text.delta", delta: "Reviewing " },
        { type: "response.reasoning_summary_text.delta", delta: "the context." },
        { type: "response.reasoning_text.delta", delta: " Verifying details." },
        { type: "response.output_text.delta", delta: "Live" },
        { type: "response.output_text.delta", delta: " response" },
        {
          type: "response.completed",
          response: {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Live response" }],
              },
            ],
          },
        },
      ]),
    );

    await expect(
      new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, {
        ...invocation,
        activityHooks: {
          status: vi.fn(),
          thinking,
          text,
          tool: vi.fn(async () => undefined),
        },
      }),
    ).resolves.toBe("Live response");
    expect(text.mock.calls).toEqual([
      ["Live", "append"],
      [" response", "append"],
    ]);
    expect(thinking.mock.calls).toEqual([
      ["Reviewing ", "append"],
      ["the context.", "append"],
      [" Verifying details.", "append"],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      reasoning: { summary: "auto" },
    });
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
                  function: {
                    name: "read",
                    arguments: JSON.stringify({ filePath: artifactPath }),
                  },
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
      "plan",
      "delegate",
      "todowrite",
      "webfetch",
      "websearch",
      "question",
    ]);
    expect(firstBody.messages[0]?.content).toContain("@builder: codex");
    const readDefinition = firstBody.tools.find(
      (tool: { function: { name: string } }) => tool.function.name === "read",
    );
    expect(readDefinition.function.parameters).toMatchObject({
      required: ["filePath"],
      properties: { filePath: { type: "string" }, offset: { type: "integer" } },
    });
    expect(readDefinition.function.parameters.properties.path).toBeUndefined();
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

  it.each(["openai-chat", "openai-responses"] as const)(
    "requires %s Masters to delegate every planned task before finalizing",
    async (protocol) => {
      const { agent, invocation, root, store } = await customMasterFixture(protocol, "full");
      const taskId = "f5a80f87-456d-4c35-9081-356cbe665510";
      const createdAt = "2026-09-03T00:00:00.000Z";
      const planArguments = JSON.stringify({
        title: "Implementation plan",
        steps: [{ title: "Build feature", description: "Implement and verify it." }],
      });
      const delegateArguments = JSON.stringify({
        taskId,
        worker: "builder",
        repository: "product-repo",
      });
      const chatResponse = (content: string | null, call?: Record<string, unknown>) => ({
        choices: [
          {
            message: {
              content,
              ...(call
                ? { tool_calls: [{ id: String(call.id), type: "function", function: call }] }
                : {}),
            },
          },
        ],
      });
      const responsesResponse = (text: string | null, call?: Record<string, unknown>) => ({
        ...(text ? { output_text: text } : {}),
        output: call
          ? [
              {
                type: "function_call",
                call_id: String(call.id),
                name: call.name,
                arguments: call.arguments,
              },
            ]
          : [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      });
      const responses =
        protocol === "openai-chat"
          ? [
              chatResponse(null, { id: "call-plan", name: "plan", arguments: planArguments }),
              chatResponse("I created the task."),
              chatResponse(null, {
                id: "call-delegate",
                name: "delegate",
                arguments: delegateArguments,
              }),
              chatResponse("The Worker completed the task."),
            ]
          : [
              responsesResponse(null, {
                id: "call-plan",
                name: "plan",
                arguments: planArguments,
              }),
              responsesResponse("I created the task."),
              responsesResponse(null, {
                id: "call-delegate",
                name: "delegate",
                arguments: delegateArguments,
              }),
              responsesResponse("The Worker completed the task."),
            ];
      const delegate = vi.fn(async () => ({
        assignment: {
          id: "assignment-1",
          workspaceId: invocation.thread.workspaceId,
          taskId,
          threadId: invocation.thread.id,
          masterRunId: invocation.runId ?? "run-tools",
          workerAgentId: "worker-1",
          repositoryId: "repository-1",
          status: "completed" as const,
          branch: "nexestra/assignment-1",
          worktreePath: "workspaces/worktree-1",
          result: "done",
          createdAt,
          updatedAt: createdAt,
        },
        result: "done",
      }));
      const repository = await store.createKnowledgeRepository({
        name: "Product repository",
        handle: "product-repo",
        source: "https://github.com/example/product.git",
      });
      const readyRepository = await store.updateKnowledgeRepository(repository.id, {
        status: "ready",
        defaultBranch: "main",
      });
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify(responses.shift())),
      );

      await expect(
        new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, {
          ...invocation,
          knowledge: [{ item: readyRepository, localPath: root }],
          toolHooks: {
            update: async () => undefined,
            requestApproval: async () => true,
            createPlan: async (_title, steps) =>
              steps.map((step) => ({
                id: taskId,
                workspaceId: invocation.thread.workspaceId,
                title: step.title,
                description: step.description,
                status: "todo" as const,
                assigneeId: null,
                threadId: invocation.thread.id,
                createdAt,
                updatedAt: createdAt,
              })),
            delegate,
          },
        }),
      ).resolves.toBe("The Worker completed the task.");

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(delegate).toHaveBeenCalledWith({
        taskId,
        workerHandle: "builder",
        repositoryHandle: "product-repo",
      });
      const correctiveRequest = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body));
      expect(JSON.stringify(correctiveRequest)).toContain(
        "Call delegate for every remaining task before returning a final answer",
      );
    },
  );

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

  it("retries transient provider failures using Retry-After", async () => {
    const { agent, invocation, store } = await customMasterFixture("openai-chat");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "Recovered." } }] })),
      );

    await expect(
      new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, invocation),
    ).resolves.toBe("Recovered.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("only stops consecutive identical calls, not repeated calls separated by other work", async () => {
    const { agent, invocation, root, store } = await customMasterFixture("openai-chat");
    await writeFile(join(root, "loop.txt"), "loop\n");
    const calls = [
      { name: "read", arguments: '{"filePath":"loop.txt"}' },
      { name: "glob", arguments: '{"pattern":"**/*"}' },
      { name: "read", arguments: '{"filePath":"loop.txt"}' },
      { name: "read", arguments: '{"filePath":"loop.txt"}' },
    ];
    let turn = 0;
    const fetchMock = vi.fn(async () => {
      const call = calls[turn];
      turn += 1;
      return new Response(
        JSON.stringify(
          call
            ? {
                choices: [
                  {
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: `call-${turn}`,
                          type: "function",
                          function: call,
                        },
                      ],
                    },
                  },
                ],
              }
            : { choices: [{ message: { content: "Finished." } }] },
        ),
      );
    });

    await expect(
      new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, invocation),
    ).resolves.toBe("Finished.");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("runs independent tool calls from one provider turn concurrently", async () => {
    const { agent, invocation, root, store } = await customMasterFixture("openai-chat");
    const toolDirectory = join(root, ".opencode", "tool");
    await mkdir(toolDirectory, { recursive: true });
    await writeFile(
      join(toolDirectory, "rendezvous.mjs"),
      [
        "let waiters = [];",
        "function meet(value) {",
        "  return new Promise((resolve) => {",
        "    waiters.push(() => resolve(value));",
        "    if (waiters.length === 2) { const ready = waiters; waiters = []; for (const done of ready) done(); }",
        "  });",
        "}",
        "export const first = { description: 'First.', timeoutMs: 1000, execute() { return meet('first'); } };",
        "export const second = { description: 'Second.', timeoutMs: 1000, execute() { return meet('second'); } };",
      ].join("\n"),
    );
    const responses = [
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "first",
                  type: "function",
                  function: { name: "rendezvous_first", arguments: "{}" },
                },
                {
                  id: "second",
                  type: "function",
                  function: { name: "rendezvous_second", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "Both completed." } }] },
    ];
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(responses.shift()));
    });

    await expect(
      new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch }).invoke(agent, invocation),
    ).resolves.toBe("Both completed.");
    expect(requestBodies[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "first", content: "first" }),
        expect.objectContaining({ role: "tool", tool_call_id: "second", content: "second" }),
      ]),
    );
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
  await store.createAgent({
    kind: "worker",
    name: "Builder",
    handle: "builder",
    description: "",
    instructions: "",
    harness: "codex",
  });
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

function sseResponse(events: unknown[]): Response {
  const encoded = new TextEncoder().encode(
    `${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")}data: [DONE]\r\n\r\n`,
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += 17) {
          controller.enqueue(encoded.slice(offset, offset + 17));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
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
  const invocation: AgentInvocation = {
    thread,
    trigger,
    transcriptPath: store.transcriptPath(thread.id),
    transcriptSnapshot: await store.transcriptSnapshot(thread.id),
    artifacts: await store.agentArtifacts(thread.id, trigger.id),
  };
  return {
    agent,
    root,
    runner: new LocalAgentRunner({ store }),
    invocation,
  };
}
