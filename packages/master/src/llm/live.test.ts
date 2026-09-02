/**
 * The one test that talks to the real API.
 *
 * It is skipped unless `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is set,
 * so `pnpm test` is green on a machine with no credentials — which is the
 * machine this package was written on. When credentials are present it runs a
 * single cheap turn: `low` effort, a tiny `max_tokens`, one trivial tool.
 *
 *     ANTHROPIC_API_KEY=sk-ant-… pnpm --filter @nexestra/master test
 *
 * What it proves is the request *shape*, not the model's judgement: adaptive
 * thinking, `output_config.effort`, prompt caching on the system prefix, the
 * strict tool schema, the fallback beta and compaction all being accepted
 * together by the live endpoint. Everything else is covered by FakeLlmClient.
 */
import { describe, expect, it } from "vitest";
import { toStrictJsonSchema } from "../tools/json-schema.js";
import { AskUserInputSchema } from "../tools/schemas.js";
import { createAnthropicLlmClient, hasAnthropicCredentials } from "./anthropic.js";
import type { LlmMessage } from "./types.js";

const live = hasAnthropicCredentials() ? describe : describe.skip;

if (!hasAnthropicCredentials()) {
  console.info(
    "[@nexestra/master] live smoke test skipped: set ANTHROPIC_API_KEY to run it against claude-opus-5.",
  );
}

live("live smoke test", () => {
  it("completes one cheap streamed turn against claude-opus-5", { timeout: 120_000 }, async () => {
    const client = createAnthropicLlmClient();
    expect(client.model).toBe("claude-opus-5");

    let text = "";
    let final: LlmMessage | null = null;

    for await (const event of client.stream({
      system: "You are a test harness probe. Answer in at most five words. Do not call any tool.",
      systemSuffix: "phase: intake",
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
      tools: [
        {
          type: "custom",
          name: "ask_user",
          description: "Ask the user questions. Not needed for this probe.",
          input_schema: toStrictJsonSchema(
            AskUserInputSchema,
          ) as import("@anthropic-ai/sdk").Anthropic.Beta.BetaTool.InputSchema,
          strict: true,
        },
      ],
      effort: "low",
      maxTokens: 1_024,
    })) {
      if (event.type === "text_delta") text += event.text;
      else if (event.type === "message") final = event.message;
    }

    expect(final).not.toBeNull();
    expect(final?.stop_reason).not.toBe("refusal");
    expect(final?.usage.input_tokens).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("ready");
  });
});
