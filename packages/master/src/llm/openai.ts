/**
 * OpenAI Responses API adapter for the Master's provider-neutral `LlmClient`
 * seam. The rest of the Master keeps one canonical conversation shape; this
 * module translates it at the network boundary.
 */
import type {
  LlmClient,
  LlmContentBlock,
  LlmMessage,
  LlmMessageParam,
  LlmRequest,
  LlmStreamEvent,
  LlmTool,
} from "./types.js";

export interface OpenAiLlmClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface OpenAiResponse {
  readonly id?: string;
  readonly model?: string;
  readonly status?: string;
  readonly incomplete_details?: { readonly reason?: string } | null;
  readonly error?: { readonly message?: string } | null;
  readonly output?: readonly OpenAiOutputItem[];
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number };
  };
}

interface OpenAiOutputItem {
  readonly type: string;
  readonly id?: string;
  readonly call_id?: string;
  readonly name?: string;
  readonly arguments?: string;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly summary?: readonly { readonly type: string; readonly text?: string }[];
}

export const OPENAI_MASTER_MODEL = "gpt-5.6";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export function createOpenAiLlmClient(options: OpenAiLlmClientOptions = {}): LlmClient {
  const model = options.model ?? OPENAI_MASTER_MODEL;
  const baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function* stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const response = await fetchImpl(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        instructions: [request.system, request.systemSuffix].filter(Boolean).join("\n\n"),
        input: toOpenAiInput(request.messages),
        tools: request.tools.map(toOpenAiTool),
        reasoning: { effort: request.effort, summary: "auto" },
        max_output_tokens: request.maxTokens,
        parallel_tool_calls: false,
        store: false,
        ...(request.outputFormat
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "master_output",
                  strict: true,
                  schema: request.outputFormat.schema,
                },
              },
            }
          : {}),
      }),
      signal: request.signal,
    });

    const requestId = response.headers.get("x-request-id");
    const payload = (await response.json().catch(() => null)) as OpenAiResponse | null;
    if (!response.ok) {
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(
        `OpenAI Responses request failed: ${detail}${requestId ? ` (${requestId})` : ""}`,
      );
    }
    if (!payload) throw new Error("OpenAI Responses request returned invalid JSON");
    if (payload.error?.message)
      throw new Error(`OpenAI Responses request failed: ${payload.error.message}`);

    const content: LlmContentBlock[] = [];
    for (const item of payload.output ?? []) {
      if (item.type === "reasoning") {
        const summary = (item.summary ?? [])
          .flatMap((part) => (part.text ? [part.text] : []))
          .join("\n");
        if (summary) yield { type: "thinking_delta", text: summary };
        continue;
      }
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if (!part.text) continue;
          yield { type: "text_delta", text: part.text };
          content.push({ type: "text", text: part.text, citations: null });
        }
        continue;
      }
      if (item.type === "function_call" && item.name) {
        content.push({
          type: "tool_use",
          id: item.call_id ?? item.id ?? `call_${content.length + 1}`,
          name: item.name,
          input: parseArguments(item.arguments),
        });
      }
    }

    yield {
      type: "message",
      message: toCanonicalMessage(payload, model, content),
    };
  }

  return { model, stream };
}

function toOpenAiInput(messages: readonly LlmMessageParam[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      input.push({ role: message.role, content: message.content });
      continue;
    }
    const text = message.content
      .flatMap((block) => (block.type === "text" && "text" in block ? [block.text] : []))
      .join("\n");
    if (text) input.push({ role: message.role, content: text });

    for (const block of message.content) {
      if (block.type === "tool_use") {
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        input.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: serialiseToolResult(block.content),
        });
      }
    }
  }
  return input;
}

function toOpenAiTool(tool: LlmTool): Record<string, unknown> {
  if (tool.type === "custom") {
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: tool.strict ?? true,
    };
  }
  if (typeof tool.type === "string" && tool.type.startsWith("web_search")) {
    return { type: "web_search" };
  }
  throw new Error(`OpenAI provider does not support Master tool type ${tool.type}`);
}

function toCanonicalMessage(
  response: OpenAiResponse,
  fallbackModel: string,
  content: LlmContentBlock[],
): LlmMessage {
  const incompleteReason = response.incomplete_details?.reason;
  const hasTools = content.some((block) => block.type === "tool_use");
  const stopReason =
    incompleteReason === "max_output_tokens" ? "max_tokens" : hasTools ? "tool_use" : "end_turn";
  return {
    id: response.id ?? "openai_response",
    type: "message",
    role: "assistant",
    model: response.model ?? fallbackModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
    container: null,
    context_management: null,
    diagnostics: null,
  } as LlmMessage;
}

function parseArguments(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { value };
  }
}

function serialiseToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}
