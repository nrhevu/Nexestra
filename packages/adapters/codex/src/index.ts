/**
 * `@nexestra/adapter-codex` — drives `codex exec --json` (PLAN.md §5).
 *
 * Filled in at M4: discover the binary and version, build the command line,
 * create the worktree, parse JSONL on stdout into `HarnessEvent`.
 */
import type { HarnessAdapter } from "@nexestra/core";

export const CODEX_ID = "codex" as const;

/** Version range this adapter has been contract-tested against. */
export const SUPPORTED_CODEX_RANGE = ">=0.140 <0.150";

/** Placeholder until the adapter lands in M4. */
export function createCodexAdapter(): HarnessAdapter {
  throw new Error("@nexestra/adapter-codex is not implemented until milestone M4");
}
