import { z } from "zod";

export const TRANSCRIPT_CONTEXT_CHARACTERS = 48_000;
export const PROVIDER_TEXT_CONTEXT_CHARACTERS = 240_000;
export const HISTORY_MESSAGE_CHARACTERS = 6_000;
export const ReadHistorySchema = z
  .object({
    beforeSequence: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(20).default(8),
    query: z.string().trim().min(1).max(200).optional(),
    messageId: z.string().min(1).max(100).optional(),
    offset: z.number().int().nonnegative().max(1_000_000).default(0),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.messageId && (input.query || input.beforeSequence))
      context.addIssue({
        code: "custom",
        message: "Read a specific message or search/page history, not both at once.",
      });
    if (!input.messageId && input.offset)
      context.addIssue({ code: "custom", message: "An offset requires a messageId." });
  });
export type ReadHistoryInput = z.infer<typeof ReadHistorySchema>;

/** Abbreviate an explicitly marked context copy, never the canonical message. */
export function shortenContext(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const marker =
    "\n[… middle omitted from context; read the original message for complete evidence …]\n";
  const remaining = Math.max(0, budget - marker.length);
  const headLength = Math.floor(remaining * 0.6);
  const tailLength = remaining - headLength;
  const head = text.slice(0, headLength).replace(/[\uD800-\uDBFF]$/, "");
  const tail = text.slice(-tailLength).replace(/^[\uDC00-\uDFFF]/, "");
  return `${head}${marker}${tail}`.slice(0, budget);
}

export function packRecentContext<T>(
  entries: T[],
  render: (entry: T) => string,
  maxCharacters = TRANSCRIPT_CONTEXT_CHARACTERS,
): string {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 1024)
    throw new Error("Conversation context must allow at least 1,024 characters.");
  const parts: string[] = [];
  let remaining = maxCharacters - 280;
  let shortened = false;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined) continue;
    if (remaining < 200) break;
    const text = render(entry);
    if (text.length > remaining) {
      parts.push(shortenContext(text, remaining));
      shortened = true;
      break;
    }
    parts.push(text);
    remaining -= text.length + 2;
  }
  const omitted = entries.length - parts.length;
  const body = parts.reverse().join("\n\n");
  if (!omitted && !shortened) return body;
  return `[Bounded conversation context: ${parts.length}/${entries.length} messages included; ${omitted} older messages omitted${shortened ? "; one message shortened" : ""}. Canonical history is unchanged. Use read_history or inspect the transcript for earlier evidence.]\n\n${body}`;
}

// This is a character guard, not a tokenizer or a billable-spend estimate. Images have separate byte limits.
export function providerTextSize(input: unknown, field = ""): number {
  if (typeof input === "string")
    return ["url", "image_url"].includes(field) &&
      /^data:image\/(png|jpeg|webp|gif);base64,/.test(input)
      ? 0
      : input.length;
  if (Array.isArray(input)) return input.reduce((sum, value) => sum + providerTextSize(value), 0);
  if (input && typeof input === "object")
    return Object.entries(input).reduce(
      (sum, [key, value]) => sum + key.length + providerTextSize(value, key),
      0,
    );
  return 0;
}

export function assertProviderTextBudget(body: unknown): void {
  const size = providerTextSize(body);
  if (size > PROVIDER_TEXT_CONTEXT_CHARACTERS)
    throw new Error(
      `Provider text context reached its ${PROVIDER_TEXT_CONTEXT_CHARACTERS.toLocaleString("en-US")}-character limit (${size.toLocaleString("en-US")} characters). The run stopped before another request. Continue in a fresh invocation using read_brief, read_goals, read_tasks and targeted read_history; use narrower tool queries and fewer or smaller attachments. Saved tasks and evidence are retained.`,
    );
}
