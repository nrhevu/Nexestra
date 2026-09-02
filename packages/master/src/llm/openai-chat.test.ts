import { describe, expect, it } from "vitest";
import { toolsForPhase } from "../tools/definitions.js";
import { createOpenAiChatLlmClient } from "./openai-chat.js";
import type { LlmStreamEvent } from "./types.js";

describe("OpenAI Chat Completions LLM client", () => {
  it("translates Master messages and tool calls", async () => {
    let url = "";
    let body: Record<string, unknown> | undefined;
    const client = createOpenAiChatLlmClient({
      apiKey: "secret",
      baseUrl: "https://models.example/v1/",
      model: "compatible-model",
      fetch: async (input, init) => {
        url = String(input);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "chat_1",
            model: "compatible-model",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "I will inspect it.",
                  tool_calls: [
                    {
                      id: "call_read",
                      type: "function",
                      function: { name: "read_workspace", arguments: '{"depth":2}' },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
        );
      },
    });

    const events: LlmStreamEvent[] = [];
    for await (const event of client.stream({
      system: "You are Master.",
      systemSuffix: "Phase: intake",
      messages: [{ role: "user", content: "Plan this" }],
      tools: toolsForPhase("intake"),
      effort: "medium",
      maxTokens: 4096,
    })) {
      events.push(event);
    }

    expect(url).toBe("https://models.example/v1/chat/completions");
    expect(body?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "system" })]),
    );
    expect(body?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "read_workspace" }),
        }),
      ]),
    );
    expect(events).toContainEqual({ type: "text_delta", text: "I will inspect it." });
    const final = events.find((event) => event.type === "message");
    expect(final?.type === "message" ? final.message.stop_reason : null).toBe("tool_use");
  });

  it("explains a 404 as an endpoint/protocol mismatch", async () => {
    const client = createOpenAiChatLlmClient({
      baseUrl: "https://models.example/v1",
      model: "model",
      fetch: async () => new Response("not found", { status: 404 }),
    });
    const consume = async () => {
      for await (const _event of client.stream({
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        effort: "medium",
        maxTokens: 128,
      })) {
        // Request fails before an event is emitted.
      }
    };
    await expect(consume()).rejects.toThrow("check the base URL and API protocol");
  });
});
