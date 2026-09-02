import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LocalAgentRunner,
  parseCodexReply,
  parseOpenCodeReply,
  parseProviderReply,
} from "./runtime.js";
import { FileStore } from "./store.js";

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
        new Response(JSON.stringify({ choices: [{ message: { content: "Đã rõ." } }] }), {
          status: 200,
        }),
    );
    const runner = new LocalAgentRunner({ store, fetch: fetchMock as typeof fetch });
    const [thread] = store.listThreads();
    if (!thread) throw new Error("expected seeded thread");
    const trigger = await store.createUserMessage(thread.id, "@maya lập kế hoạch", [
      { agentId: created.id, handle: created.handle },
    ]);
    await store.createUserMessage(thread.id, "message mới hơn không được thay mục tiêu", []);

    const reply = await runner.invoke(created, {
      thread,
      trigger,
      transcriptPath: store.transcriptPath(thread.id),
      transcriptSnapshot: await store.transcriptSnapshot(thread.id),
    });

    expect(reply).toBe("Đã rõ.");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    if (!init) throw new Error("expected request init");
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(String(init.body)).toContain("@maya lập kế hoạch");
    expect(String(init.body)).toContain(`Message bắt buộc phải trả lời (id: ${trigger.id})`);
    expect(String(init.body)).toContain("kể cả khi transcript có message mới hơn");

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
    ).rejects.toThrow("quá nhiều dữ liệu");
  });
});
