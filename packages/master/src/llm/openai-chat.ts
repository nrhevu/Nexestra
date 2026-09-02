/** OpenAI-compatible Chat Completions adapter for custom Master providers. */
import type {
  LlmClient,
  LlmContentBlock,
  LlmMessage,
  LlmMessageParam,
  LlmRequest,
  LlmStreamEvent,
  LlmTool,
} from "./types.js";

export interface OpenAiChatLlmClientOptions {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly fetch?: typeof globalThis.fetch;
}

interface ChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly {
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
  readonly error?: { readonly message?: string } | null;
}

export function createOpenAiChatLlmClient(options: OpenAiChatLlmClientOptions): LlmClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function* stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const endpoint = `${baseUrl}/chat/completions`;
    const tools = request.tools.flatMap(toChatTool);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          {
            role: "system",
            content: [request.system, request.systemSuffix].filter(Boolean).join("\n\n"),
          },
          ...toChatMessages(request.messages),
        ],
        ...(tools.length > 0 ? { tools, parallel_tool_calls: false } : {}),
        max_tokens: request.maxTokens,
        stream: false,
        ...(request.outputFormat
          ? {
              response_format: {
                type: "json_schema",
                json_schema: {
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
    const payload = (await response.json().catch(() => null)) as ChatResponse | null;
    if (!response.ok) {
      const detail = payload?.error?.message ?? `HTTP ${response.status}`;
      const hint =
        response.status === 404
          ? `; endpoint ${endpoint} was not found — check the base URL and API protocol`
          : "";
      throw new Error(
        `OpenAI Chat Completions request failed: ${detail}${hint}${
          requestId ? ` (${requestId})` : ""
        }`,
      );
    }
    if (!payload) throw new Error("OpenAI Chat Completions request returned invalid JSON");
    if (payload.error?.message) {
      throw new Error(`OpenAI Chat Completions request failed: ${payload.error.message}`);
    }

    const choice = payload.choices?.[0];
    if (!choice?.message) throw new Error("OpenAI Chat Completions response had no message");

    const content: LlmContentBlock[] = [];
    if (choice.message.content) {
      yield { type: "text_delta", text: choice.message.content };
      content.push({ type: "text", text: choice.message.content, citations: null });
    }
    for (const [index, call] of (choice.message.tool_calls ?? []).entries()) {
      if (!call.function?.name) continue;
      content.push({
        type: "tool_use",
        id: call.id ?? `call_${index + 1}`,
        name: call.function.name,
        input: parseArguments(call.function.arguments),
      });
    }

    yield {
      type: "message",
      message: toCanonicalMessage(payload, choice.finish_reason, content),
    };
  }

  return { model: options.model, stream };
}

function toChatMessages(messages: readonly LlmMessageParam[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      result.push({ role: message.role, content: message.content });
      continue;
    }

    const text = message.content
      .flatMap((block) => (block.type === "text" && "text" in block ? [block.text] : []))
      .join("\n");
    const calls = message.content.flatMap((block) =>
      block.type === "tool_use"
        ? [
            {
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            },
          ]
        : [],
    );
    if (text || calls.length > 0) {
      result.push({
        role: message.role,
        content: text || null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    }
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      result.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: serialiseToolResult(block.content),
      });
    }
  }
  return result;
}

function toChatTool(tool: LlmTool): Record<string, unknown>[] {
  if (tool.type !== "custom") return [];
  return [
    {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
        strict: tool.strict ?? true,
      },
    },
  ];
}

function toCanonicalMessage(
  response: ChatResponse,
  finishReason: string | null | undefined,
  content: LlmContentBlock[],
): LlmMessage {
  const hasTools = content.some((block) => block.type === "tool_use");
  const stopReason = finishReason === "length" ? "max_tokens" : hasTools ? "tool_use" : "end_turn";
  return {
    id: response.id ?? "openai_chat_completion",
    type: "message",
    role: "assistant",
    model: response.model ?? "unknown",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
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
    return { raw: value };
  }
}

function serialiseToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => {
        if (typeof item === "string") return [item];
        if (item && typeof item === "object" && "text" in item) return [String(item.text)];
        return [JSON.stringify(item)];
      })
      .join("\n");
  }
  return JSON.stringify(value);
}
