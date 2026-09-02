/**
 * `AnthropicLlmClient` — the real model behind the Master.
 *
 * Choices worth knowing about (PLAN.md §4):
 *
 * - `claude-opus-5` with `thinking: {type: "adaptive"}`. Effort comes from the
 *   caller: `high` for planning, `medium` for ordinary chat turns.
 * - Streaming with `finalMessage()`, because Master turns can be long and a
 *   non-streaming request would sit on an HTTP timeout.
 * - Prompt caching on the stable system prefix and on the tool list. The
 *   volatile part of the prompt (the current spec digest, budget, phase) goes
 *   into a *second* system block after the breakpoint, so the cached prefix
 *   stays byte-identical across turns.
 * - `betas: ["server-side-fallback-2026-07-01"]` + `fallbacks: "default"`, so a
 *   policy refusal on one turn does not break the whole orchestration loop.
 * - Compaction (`compact-2026-01-12`) for threads that outgrow the window; the
 *   session appends `response.content` verbatim, which is what makes the
 *   compaction blocks usable on the next request.
 *
 * Not used, deliberately: assistant prefill (rejected on Opus 5),
 * `budget_tokens` (rejected on Opus 5), and forced `tool_choice` — the phase
 * machine already constrains what the model can do.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmMessage, LlmRequest, LlmStreamEvent } from "./types.js";

export const MASTER_MODEL = "claude-opus-5";

export const MASTER_BETAS = ["server-side-fallback-2026-07-01", "compact-2026-01-12"] as const;

/** Compaction kicks in this far into the window; the API default is 150k. */
const COMPACTION_TRIGGER_TOKENS = 150_000;

export interface AnthropicLlmClientOptions {
  /** Pre-built SDK client. Omit to construct one from the ambient credentials. */
  readonly client?: Anthropic;
  readonly apiKey?: string;
  readonly model?: string;
  /** Turn off compaction for short-lived sessions. Default: on. */
  readonly compaction?: boolean;
  /** Ask for readable thinking summaries in the stream. Default: on. */
  readonly thinkingSummaries?: boolean;
}

export function createAnthropicLlmClient(options: AnthropicLlmClientOptions = {}): LlmClient {
  const client =
    options.client ?? new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
  const model = options.model ?? MASTER_MODEL;
  const compaction = options.compaction !== false;
  const thinkingSummaries = options.thinkingSummaries !== false;

  async function* stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const system: Anthropic.Beta.BetaTextBlockParam[] = [
      { type: "text", text: request.system, cache_control: { type: "ephemeral" } },
    ];
    if (request.systemSuffix) system.push({ type: "text", text: request.systemSuffix });

    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model,
      max_tokens: request.maxTokens,
      betas: [...MASTER_BETAS],
      fallbacks: "default",
      thinking: { type: "adaptive", display: thinkingSummaries ? "summarized" : "omitted" },
      output_config: {
        effort: request.effort,
        ...(request.outputFormat
          ? { format: { type: "json_schema" as const, schema: request.outputFormat.schema } }
          : {}),
      },
      system,
      messages: request.messages as Anthropic.Beta.BetaMessageParam[],
      tools: request.tools as Anthropic.Beta.BetaToolUnion[],
      stream: true,
      ...(compaction
        ? {
            context_management: {
              edits: [
                {
                  type: "compact_20260112" as const,
                  trigger: { type: "input_tokens" as const, value: COMPACTION_TRIGGER_TOKENS },
                },
              ],
            },
          }
        : {}),
    };

    const runner = client.beta.messages.stream(
      params,
      request.signal ? { signal: request.signal } : undefined,
    );

    try {
      for await (const event of runner) {
        if (event.type !== "content_block_delta") continue;
        if (event.delta.type === "text_delta") {
          yield { type: "text_delta", text: event.delta.text };
        } else if (event.delta.type === "thinking_delta") {
          yield { type: "thinking_delta", text: event.delta.thinking };
        }
      }
      const message = (await runner.finalMessage()) as LlmMessage;
      yield { type: "message", message };
    } finally {
      if (!runner.ended) runner.abort();
    }
  }

  return { model, stream };
}

/**
 * True when the process has credentials the SDK can pick up. `ANTHROPIC_API_KEY`
 * is only one of several sources, but it is the one CI and the live smoke test
 * gate on.
 */
export function hasAnthropicCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN);
}
