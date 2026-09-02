/**
 * `@nexestra/master` — the Master agent (PLAN.md §4).
 *
 * Filled in at M2: system prompt, the per-phase tool surface
 * (`ask_user`, `update_spec`, `read_workspace`, `search_code`, `web_search`,
 * `record_memory`, `request_approval`) and the clarification loop.
 *
 * M0 only fixes the shape of the state machine so the rest of the workspace
 * can depend on it.
 */
import type { ThreadPhase } from "@nexestra/core";

/** Tool names the Master is allowed to call in a given phase. */
export const MASTER_TOOLS_BY_PHASE: Record<ThreadPhase, readonly string[]> = {
  intake: ["read_workspace", "search_code", "web_search"],
  clarifying: ["ask_user", "update_spec", "record_memory"],
  spec_frozen: ["request_approval"],
  planning: ["propose_plan", "record_memory"],
  executing: [
    "dispatch_task",
    "read_run_events",
    "read_artifact",
    "control_run",
    "request_approval",
    "replan",
  ],
  verifying: ["run_verification", "read_artifact", "mark_criterion"],
  done: ["summarize", "record_memory"],
  blocked: ["summarize", "request_approval"],
  cancelled: [],
};

export const MASTER_MODEL = "claude-opus-5";

/** Placeholder until the real loop lands in M2. */
export function createMaster(): never {
  throw new Error("@nexestra/master is not implemented until milestone M2");
}
