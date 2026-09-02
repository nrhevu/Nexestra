import { describe, expect, it } from "vitest";
import { toolsForPhase } from "../tools/definitions.js";
import { createOpenAiLlmClient } from "./openai.js";
import type { LlmStreamEvent } from "./types.js";

describe("OpenAI Responses LLM client", () => {
  it("translates Master tools and function calls without storing API response state", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | null = null;
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(
        JSON.stringify({
          id: "resp_1",
          model: "gpt-test",
          status: "completed",
          output: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "Check the repository first." }],
            },
            {
              type: "message",
              content: [{ type: "output_text", text: "I will inspect it." }],
            },
            {
              type: "function_call",
              call_id: "call_read",
              name: "read_workspace",
              arguments: '{"depth":2}',
            },
          ],
          usage: {
            input_tokens: 11,
            output_tokens: 7,
            input_tokens_details: { cached_tokens: 3 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = createOpenAiLlmClient({
      apiKey: "server-secret",
      baseUrl: "https://models.example/v1/",
      model: "gpt-test",
      fetch: fetchMock,
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

    expect(authorization).toBe("Bearer server-secret");
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.instructions).toContain("Phase: intake");
    expect(requestBody?.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "web_search" }),
        expect.objectContaining({ type: "function", name: "read_workspace", strict: true }),
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "thinking_delta", text: "Check the repository first." },
        { type: "text_delta", text: "I will inspect it." },
      ]),
    );

    const final = events.find((event) => event.type === "message");
    expect(final?.type === "message" ? final.message.stop_reason : null).toBe("tool_use");
    expect(final?.type === "message" ? final.message.content : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_use",
          id: "call_read",
          name: "read_workspace",
          input: { depth: 2 },
        }),
      ]),
    );
  });

  it("surfaces API errors with the request id", async () => {
    const client = createOpenAiLlmClient({
      apiKey: "bad",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "invalid key" } }), {
          status: 401,
          headers: { "x-request-id": "req_123" },
        }),
    });

    const consume = async () => {
      for await (const _event of client.stream({
        system: "system",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        effort: "medium",
        maxTokens: 128,
      })) {
        // The request fails before an event is emitted.
      }
    };

    await expect(consume()).rejects.toThrow("invalid key (req_123)");
  });
});
