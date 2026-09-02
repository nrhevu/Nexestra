import { z } from "zod";

/**
 * Token prices, in USD per million tokens.
 *
 * Harnesses report tokens, not money: `codex exec --json` emits a
 * `token_count` per turn and never a price (`docs/harness-protocols.md` §1.6),
 * and OpenCode only prices the models it bills itself. The orchestrator turns
 * tokens into dollars with a table like this one, and an **unknown model costs
 * zero** rather than a guess — a wrong number would pause a thread on a budget
 * that was never actually spent.
 */
export const ModelPriceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  /** Defaults to 10% of `inputPerMTok`, the usual cache-read discount. */
  cachedInputPerMTok: z.number().nonnegative().optional(),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PriceTableSchema = z.record(z.string(), ModelPriceSchema);
export type PriceTable = z.infer<typeof PriceTableSchema>;

/**
 * List prices as published for the models Nexestra drives by default.
 *
 * Deliberately small: it exists so the cost column on the board is not always
 * `$0.00`, not so Nexestra can bill anyone. Override or extend it from the
 * Settings surface when a price changes; anything absent is free.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  "gpt-5.1-codex": { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
  "gpt-5.1-codex-mini": { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 },
  "anthropic/claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 },
  "anthropic/claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
};
