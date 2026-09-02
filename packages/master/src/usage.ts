/**
 * Usage accounting.
 *
 * Tokens come straight from the API response; dollars are estimated locally
 * from a small price table so budget rules (PLAN.md §4.2) can fire without a
 * round-trip. The table is the published per-MTok list price; when a model is
 * unknown the cost is left at zero rather than guessed, so a wrong number can
 * never silently pause a thread.
 */
import type { MasterUsageTotals } from "./events.js";
import type { LlmUsage } from "./llm/types.js";

export const ZERO_USAGE: MasterUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUSD: 0,
};

interface ModelPrice {
  /** USD per million input tokens. */
  readonly input: number;
  /** USD per million output tokens. */
  readonly output: number;
}

const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Cache reads bill at ~0.1x input, cache writes at ~1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCostUSD(usage: MasterUsageTotals, model: string): number {
  const price = PRICES[model];
  if (!price) return 0;
  const perToken = price.input / 1_000_000;
  return (
    usage.inputTokens * perToken +
    usage.cacheReadTokens * perToken * CACHE_READ_MULTIPLIER +
    usage.cacheWriteTokens * perToken * CACHE_WRITE_MULTIPLIER +
    (usage.outputTokens * price.output) / 1_000_000
  );
}

/** Turn one API `usage` block into totals, cost included. */
export function toUsageTotals(usage: LlmUsage, model: string): MasterUsageTotals {
  const partial: MasterUsageTotals = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUSD: 0,
  };
  return { ...partial, costUSD: estimateCostUSD(partial, model) };
}

export function addUsage(a: MasterUsageTotals, b: MasterUsageTotals): MasterUsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUSD: a.costUSD + b.costUSD,
  };
}

/** PLAN.md §4.2: warn at 80% of the thread budget, stop at 100%. */
export const BUDGET_WARNING_RATIO = 0.8;

export type BudgetState = "ok" | "warning" | "exceeded";

export function budgetState(usage: MasterUsageTotals, budgetUSD: number): BudgetState {
  if (budgetUSD <= 0) return "ok";
  if (usage.costUSD >= budgetUSD) return "exceeded";
  if (usage.costUSD >= budgetUSD * BUDGET_WARNING_RATIO) return "warning";
  return "ok";
}
