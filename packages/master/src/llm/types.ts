/**
 * The seam between the Master loop and the model.
 *
 * One narrow interface, two implementations: `AnthropicLlmClient` (the real
 * thing) and `FakeLlmClient` (a script of canned turns). Everything above this
 * line — phases, tool validation, spec/plan bookkeeping, budget — is therefore
 * testable without an API key.
 *
 * The types are the SDK's own beta types rather than home-grown mirrors: the
 * session appends `response.content` back into the history verbatim, so
 * thinking and compaction blocks survive round-trips, and re-typing those
 * blocks would be a lie waiting to drift.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type LlmContentBlock = Anthropic.Beta.BetaContentBlock;
export type LlmMessageParam = Anthropic.Beta.BetaMessageParam;
export type LlmTool = Anthropic.Beta.BetaToolUnion;
export type LlmMessage = Anthropic.Beta.BetaMessage;
export type LlmUsage = Anthropic.Beta.BetaUsage;
export type LlmToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;
export type LlmToolUseBlock = Anthropic.Beta.BetaToolUseBlock;

export interface LlmRequest {
  /** Conversation identity for callers that resolve a model profile per thread. */
  readonly threadId?: string;
  /** Stable, cached prefix. */
  readonly system: string;
  /** Volatile per-turn context appended after the cached prefix. */
  readonly systemSuffix?: string;
  readonly messages: readonly LlmMessageParam[];
  readonly tools: readonly LlmTool[];
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
  readonly maxTokens: number;
  /** Structured output, used when a turn must produce one exact object. */
  readonly outputFormat?: { readonly schema: Record<string, unknown> };
  readonly signal?: AbortSignal;
}

/**
 * Incremental events. `message` is terminal and always arrives last — a stream
 * that ends without it is an error.
 */
export type LlmStreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "message"; readonly message: LlmMessage };

export interface LlmClient {
  /** Model id reported in events and used for cost estimation. */
  readonly model: string;
  stream(request: LlmRequest): AsyncIterable<LlmStreamEvent>;
}
