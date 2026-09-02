/**
 * `@nexestra/adapter-opencode` — drives `opencode serve` over HTTP + SSE
 * (PLAN.md §5).
 *
 * Filled in at M5: one server process per workspace, a session per run,
 * SSE events mapped onto `HarnessEvent`, permission replies over the API.
 */
import type { HarnessAdapter } from "@nexestra/core";

export const OPENCODE_ID = "opencode" as const;

/** Version range this adapter has been contract-tested against. */
export const SUPPORTED_OPENCODE_RANGE = ">=1.18 <2";

/** Placeholder until the adapter lands in M5. */
export function createOpenCodeAdapter(): HarnessAdapter {
  throw new Error("@nexestra/adapter-opencode is not implemented until milestone M5");
}
