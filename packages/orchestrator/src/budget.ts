/**
 * Cost accounting (PLAN.md §4.2, §9).
 *
 * Harnesses differ: OpenCode reports money, Codex reports tokens only. When a
 * `usage` event carries `costUSD` it wins; otherwise the configured price table
 * turns tokens into dollars. An unknown model costs **zero** rather than a
 * guess, because a wrong number would silently pause a thread.
 */
import type { HarnessEvent, Usage } from "@nexestra/core";
import type { PriceTable } from "./config.js";

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUSD: 0,
};

/** Price a `usage` event. Returns 0 for a model the table does not know. */
export function priceUsage(
  event: Extract<HarnessEvent, { type: "usage" }>,
  model: string | undefined,
  table: PriceTable,
): number {
  if (event.costUSD !== undefined) return event.costUSD;
  const price = model ? table[model] : undefined;
  if (!price) return 0;
  return (
    (event.inputTokens / 1_000_000) * price.inputPerMTok +
    (event.outputTokens / 1_000_000) * price.outputPerMTok
  );
}

/**
 * Fold a `usage` event into a running total.
 *
 * Harnesses report usage cumulatively *or* incrementally depending on the
 * harness; Codex emits one final `token_count` per turn. The loop therefore
 * treats every event as an increment and lets the adapter decide how often to
 * emit — which is what `HarnessEvent.usage` documents.
 */
export function addUsage(
  total: Usage,
  event: Extract<HarnessEvent, { type: "usage" }>,
  cost: number,
): Usage {
  return {
    inputTokens: total.inputTokens + event.inputTokens,
    outputTokens: total.outputTokens + event.outputTokens,
    cachedInputTokens: total.cachedInputTokens,
    costUSD: total.costUSD + cost,
  };
}

export type BudgetLevel = "ok" | "warning" | "exceeded";

export interface BudgetState {
  level: BudgetLevel;
  costUSD: number;
  budgetUSD: number;
  ratio: number;
}

/** Where a thread stands against its budget. No budget means never blocked. */
export function budgetState(costUSD: number, budgetUSD: number, warningRatio: number): BudgetState {
  if (budgetUSD <= 0) return { level: "ok", costUSD, budgetUSD, ratio: 0 };
  const ratio = costUSD / budgetUSD;
  const level: BudgetLevel = ratio >= 1 ? "exceeded" : ratio >= warningRatio ? "warning" : "ok";
  return { level, costUSD, budgetUSD, ratio };
}
