/**
 * `FakeLlmClient` — a scripted model.
 *
 * Tests describe a run as a list of turns; the fake replays them in order and
 * records the requests it was given, so a test can assert on the tool surface
 * and the prompt the session built as well as on the resulting events.
 *
 * There is no API key on the machine this package was written on, so this is
 * the client every test uses. The live smoke test is the only place
 * `AnthropicLlmClient` runs.
 */
import type {
  LlmClient,
  LlmContentBlock,
  LlmMessage,
  LlmRequest,
  LlmStreamEvent,
} from "./types.js";

export interface FakeTurn {
  /** Text streamed before the final message; also becomes a `text` block. */
  readonly text?: string;
  /** Thinking summary streamed before the text. */
  readonly thinking?: string;
  /** Tool calls this turn makes. */
  readonly toolUses?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
  readonly stopReason?: LlmMessage["stop_reason"];
  readonly stopDetails?: LlmMessage["stop_details"];
  readonly usage?: Partial<LlmMessage["usage"]>;
  /** Throw instead of answering, to exercise transport failures. */
  readonly error?: Error;
  /** Extra blocks appended verbatim (thinking blocks, compaction blocks…). */
  readonly extraBlocks?: readonly LlmContentBlock[];
}

export interface FakeLlmClientOptions {
  readonly model?: string;
  /** Called for every request, before the turn is replayed. */
  readonly onRequest?: (request: LlmRequest, index: number) => void;
}

export interface FakeLlmClient extends LlmClient {
  /** Every request the session made, in order. */
  readonly requests: readonly LlmRequest[];
  /** Turns not yet consumed. */
  readonly remaining: number;
  push(...turns: readonly FakeTurn[]): void;
}

function usageOf(turn: FakeTurn): LlmMessage["usage"] {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    fallback_credit: null,
    inference_geo: null,
    iterations: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
    ...turn.usage,
  };
}

function contentOf(turn: FakeTurn): LlmContentBlock[] {
  const content: LlmContentBlock[] = [];
  if (turn.thinking !== undefined) {
    content.push({ type: "thinking", thinking: turn.thinking, signature: "fake-signature" });
  }
  if (turn.text !== undefined) {
    content.push({ type: "text", text: turn.text, citations: null });
  }
  for (const use of turn.toolUses ?? []) {
    content.push({ type: "tool_use", id: use.id, name: use.name, input: use.input });
  }
  content.push(...(turn.extraBlocks ?? []));
  return content;
}

export function createFakeLlmClient(
  script: readonly FakeTurn[] = [],
  options: FakeLlmClientOptions = {},
): FakeLlmClient {
  const model = options.model ?? "fake-opus";
  const queue: FakeTurn[] = [...script];
  const requests: LlmRequest[] = [];

  async function* stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const index = requests.length;
    requests.push(request);
    options.onRequest?.(request, index);

    const turn = queue.shift();
    if (!turn) {
      throw new Error(
        `FakeLlmClient: no scripted turn left (request #${index + 1}). ` +
          "The session asked the model more times than the script expected.",
      );
    }
    if (turn.error) throw turn.error;

    if (turn.thinking !== undefined) yield { type: "thinking_delta", text: turn.thinking };
    if (turn.text !== undefined) yield { type: "text_delta", text: turn.text };

    const content = contentOf(turn);
    const stopReason =
      turn.stopReason ??
      (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn");

    const message: LlmMessage = {
      id: `msg_fake_${index + 1}`,
      type: "message",
      role: "assistant",
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      stop_details: turn.stopDetails ?? null,
      usage: usageOf(turn),
      container: null,
      context_management: null,
      diagnostics: null,
    };
    yield { type: "message", message };
  }

  return {
    model,
    stream,
    get requests() {
      return requests;
    },
    get remaining() {
      return queue.length;
    },
    push(...turns: readonly FakeTurn[]) {
      queue.push(...turns);
    },
  };
}
