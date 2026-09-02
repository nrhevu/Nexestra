/**
 * The Master's phase state machine (PLAN.md §4).
 *
 * The machine lives in code, not in the model: `nextPhase()` is a pure
 * function, every transition is guarded, and the LLM only ever fills in
 * content for the phase the machine has already put it in. The tool surface
 * handed to the model is derived from the phase, so a model that "forgets"
 * the process physically cannot call a tool that belongs to another phase.
 */
import type { ThreadPhase } from "@nexestra/core";

/** Every tool the Master can ever call, including the server-side one. */
export const MASTER_TOOL_NAMES = [
  "read_workspace",
  "search_code",
  "search_memory",
  "web_search",
  "ask_user",
  "update_spec",
  "record_memory",
  "request_approval",
  "propose_plan",
  "replan",
  "dispatch_task",
  "read_run_events",
  "read_artifact",
  "control_run",
  "run_verification",
  "mark_criterion",
  "summarize",
] as const;

export type MasterToolName = (typeof MASTER_TOOL_NAMES)[number];

/**
 * Tool names the Master is allowed to call in a given phase.
 *
 * This is PLAN.md §4.1 plus the minimum additions the loop needs to actually
 * move: `intake` can already ask/draft (otherwise it could never leave the
 * phase), `clarifying` can request the spec approval that freezes it, and
 * `record_memory` is available wherever the Master produces durable facts.
 */
export const MASTER_TOOLS_BY_PHASE: Record<ThreadPhase, readonly MasterToolName[]> = {
  intake: [
    "read_workspace",
    "search_code",
    "search_memory",
    "web_search",
    "ask_user",
    "update_spec",
    "record_memory",
  ],
  clarifying: [
    "ask_user",
    "update_spec",
    "record_memory",
    "read_workspace",
    "search_code",
    "search_memory",
    "web_search",
    "request_approval",
  ],
  spec_frozen: ["request_approval", "record_memory", "summarize"],
  planning: ["propose_plan", "record_memory", "read_workspace", "search_code", "search_memory"],
  executing: [
    "dispatch_task",
    "read_run_events",
    "read_artifact",
    "control_run",
    "request_approval",
    "replan",
    "record_memory",
    "search_memory",
  ],
  verifying: [
    "run_verification",
    "read_artifact",
    "mark_criterion",
    "record_memory",
    "search_memory",
  ],
  done: ["summarize", "record_memory", "search_memory"],
  blocked: ["summarize", "request_approval", "record_memory", "search_memory"],
  cancelled: [],
};

/** Is `tool` part of `phase`'s tool surface? */
export function isToolAllowedInPhase(phase: ThreadPhase, tool: string): boolean {
  return (MASTER_TOOLS_BY_PHASE[phase] as readonly string[]).includes(tool);
}

/**
 * Facts the guards need. Supplied by the session from the current spec / plan;
 * kept as plain counters so the transition function stays pure and cheap.
 */
export interface PhaseContext {
  /** Open questions on the current spec that still have no answer. */
  readonly openQuestionCount: number;
  /** Acceptance criteria on the current spec. */
  readonly acceptanceCriterionCount: number;
  /** Acceptance criteria that still lack an `evidenceArtifactId`. */
  readonly unverifiedCriterionCount: number;
  /** True once the user approved the spec. */
  readonly specApproved: boolean;
  /** True once a plan proposal passed validation. */
  readonly planProposed: boolean;
}

export const EMPTY_PHASE_CONTEXT: PhaseContext = {
  openQuestionCount: 0,
  acceptanceCriterionCount: 0,
  unverifiedCriterionCount: 0,
  specApproved: false,
  planProposed: false,
};

/**
 * Things that can happen to a thread. Triggers come from the session (tool
 * results, user input) and from the orchestrator (`applyTrigger`), never from
 * the model directly.
 */
export type PhaseTrigger =
  /** The Master started drafting: it asked a question or wrote to the spec. */
  | { readonly type: "clarification_started" }
  /** The user approved the spec. */
  | { readonly type: "spec_approved" }
  /** The user (or the Master) reopened a frozen spec. */
  | { readonly type: "spec_reopened" }
  /** The session is about to plan; only legal from `spec_frozen`. */
  | { readonly type: "planning_started" }
  /** The user accepted a proposed plan; execution may start. */
  | { readonly type: "plan_accepted" }
  /** Every task in the plan reached `done`. */
  | { readonly type: "all_tasks_done" }
  /** Verification found a failing criterion; go back to executing. */
  | { readonly type: "verification_failed" }
  /** Every acceptance criterion has evidence. */
  | { readonly type: "all_criteria_verified" }
  /** Something needs a human: budget, repeated failure, a hard decision. */
  | { readonly type: "blocked"; readonly reason: string }
  /** A blocked thread was released back into `resumePhase`. */
  | { readonly type: "unblocked"; readonly resumePhase: ThreadPhase }
  /** The user cancelled the thread. */
  | { readonly type: "cancelled" };

export type PhaseTransition =
  | {
      readonly ok: true;
      readonly from: ThreadPhase;
      readonly to: ThreadPhase;
      readonly changed: boolean;
      readonly reason: string;
    }
  | {
      readonly ok: false;
      readonly from: ThreadPhase;
      readonly reason: string;
    };

const TERMINAL_PHASES: readonly ThreadPhase[] = ["done", "cancelled"];

function ok(from: ThreadPhase, to: ThreadPhase, reason: string): PhaseTransition {
  return { ok: true, from, to, changed: from !== to, reason };
}

function reject(from: ThreadPhase, reason: string): PhaseTransition {
  return { ok: false, from, reason };
}

/**
 * The transition function. Pure: same inputs, same output, no I/O.
 *
 * Illegal transitions are rejected with a reason rather than silently
 * ignored, so a caller can surface "you cannot do that yet" to the user.
 */
export function nextPhase(
  current: ThreadPhase,
  trigger: PhaseTrigger,
  context: PhaseContext = EMPTY_PHASE_CONTEXT,
): PhaseTransition {
  if (trigger.type === "cancelled") {
    if (current === "cancelled") return ok(current, "cancelled", "already cancelled");
    return ok(current, "cancelled", "cancelled by user");
  }

  if (TERMINAL_PHASES.includes(current)) {
    return reject(current, `thread is ${current}; only \`cancelled\` is still accepted`);
  }

  switch (trigger.type) {
    case "clarification_started":
      if (current === "intake") return ok(current, "clarifying", "clarification started");
      if (current === "clarifying") return ok(current, "clarifying", "already clarifying");
      return reject(current, "clarification can only start from `intake`");

    case "spec_approved":
      if (current !== "clarifying" && current !== "intake" && current !== "spec_frozen") {
        return reject(current, "the spec can only be frozen from `intake`/`clarifying`");
      }
      if (context.openQuestionCount > 0) {
        return reject(
          current,
          `${context.openQuestionCount} open question(s) remain; the spec cannot be frozen`,
        );
      }
      if (context.acceptanceCriterionCount < 1) {
        return reject(current, "the spec has no acceptance criteria; it cannot be frozen");
      }
      return ok(current, "spec_frozen", "spec approved by user");

    case "spec_reopened":
      if (current === "spec_frozen" || current === "planning" || current === "executing") {
        return ok(current, "clarifying", "spec reopened");
      }
      if (current === "clarifying") return ok(current, "clarifying", "spec already open");
      return reject(current, `cannot reopen the spec from \`${current}\``);

    case "planning_started":
      if (current === "spec_frozen") return ok(current, "planning", "planning started");
      if (current === "planning") return ok(current, "planning", "already planning");
      return reject(current, "planning can only start from `spec_frozen`");

    case "plan_accepted":
      if (current !== "planning")
        return reject(current, "a plan can only be accepted while planning");
      if (!context.planProposed) return reject(current, "no validated plan has been proposed yet");
      return ok(current, "executing", "plan accepted");

    case "all_tasks_done":
      if (current !== "executing")
        return reject(current, "tasks can only complete while executing");
      return ok(current, "verifying", "all tasks done");

    case "verification_failed":
      if (current !== "verifying")
        return reject(current, "verification only fails while verifying");
      return ok(current, "executing", "verification failed; back to executing");

    case "all_criteria_verified":
      if (current !== "verifying")
        return reject(current, "criteria are only verified while verifying");
      if (context.acceptanceCriterionCount < 1) {
        return reject(current, "the spec has no acceptance criteria to verify");
      }
      if (context.unverifiedCriterionCount > 0) {
        return reject(
          current,
          `${context.unverifiedCriterionCount} criterion/criteria still lack evidence`,
        );
      }
      return ok(current, "done", "every acceptance criterion has evidence");

    case "blocked":
      if (current === "blocked") return ok(current, "blocked", trigger.reason);
      return ok(current, "blocked", trigger.reason);

    case "unblocked":
      if (current !== "blocked") return reject(current, "the thread is not blocked");
      if (TERMINAL_PHASES.includes(trigger.resumePhase)) {
        return reject(current, `cannot resume into terminal phase \`${trigger.resumePhase}\``);
      }
      return ok(current, trigger.resumePhase, "unblocked");

    default: {
      const exhaustive: never = trigger;
      return reject(current, `unknown trigger ${JSON.stringify(exhaustive)}`);
    }
  }
}
