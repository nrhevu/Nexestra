/**
 * What a Master turn emits, and what can be sent into one.
 *
 * `MasterSession.send()` returns an async iterable of `MasterEvent`. The
 * server forwards these over the WebSocket more or less verbatim; the Chat
 * surface renders `text_delta` / `thinking_summary` / `tool_call`, the sidebar
 * reacts to `spec_updated` / `approval_requested`, and the Task Board reacts
 * to `plan_proposed`.
 */
import type { Spec, ThreadPhase } from "@nexestra/core";
import type { ApprovalRequestResult } from "./host.js";
import type { MasterPlanProposal } from "./plan.js";
import type { AskUserQuestion, RequestApprovalInput } from "./tools/schemas.js";

/** Why a turn ended. Everything but `end_turn` means the caller must act. */
export type MasterTurnOutcome =
  | "end_turn"
  | "awaiting_answers"
  | "awaiting_approval"
  | "max_iterations"
  | "budget_exceeded"
  | "cancelled"
  | "error";

export interface MasterUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUSD: number;
}

export type MasterErrorCode =
  | "refusal"
  | "max_tokens"
  | "context_window_exceeded"
  | "transport"
  | "tool"
  | "phase"
  | "budget"
  | "internal";

export interface MasterError {
  readonly code: MasterErrorCode;
  readonly message: string;
  /** Refusal category from `stop_details`, when the model declined. */
  readonly category?: string | null;
  readonly retryable: boolean;
}

export type MasterEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_summary"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly ok: boolean;
      readonly output: unknown;
    }
  | {
      readonly type: "question";
      readonly callId: string;
      readonly questions: readonly AskUserQuestion[];
    }
  | { readonly type: "spec_updated"; readonly spec: Spec }
  | { readonly type: "plan_proposed"; readonly plan: MasterPlanProposal }
  | {
      readonly type: "approval_requested";
      /** Absent for approvals the Master raised on its own (budget warnings). */
      readonly callId?: string;
      readonly approval: ApprovalRequestResult;
      readonly request: RequestApprovalInput;
    }
  | {
      readonly type: "phase_changed";
      readonly from: ThreadPhase;
      readonly to: ThreadPhase;
      readonly reason: string;
    }
  | {
      readonly type: "usage";
      readonly turn: MasterUsageTotals;
      readonly thread: MasterUsageTotals;
      readonly budgetUSD: number;
    }
  | { readonly type: "error"; readonly error: MasterError }
  | { readonly type: "done"; readonly outcome: MasterTurnOutcome; readonly phase: ThreadPhase };

/* ------------------------------------------------------------------- inputs */

export interface UserMessageInput {
  readonly kind: "user_message";
  readonly text: string;
}

export interface ToolAnswerInput {
  readonly kind: "answers";
  /** The `ask_user` call being answered; omit to answer the pending one. */
  readonly callId?: string;
  readonly answers: readonly { readonly id: string; readonly answer: string }[];
}

export interface ApprovalDecisionInput {
  readonly kind: "approval";
  readonly callId?: string;
  readonly approvalId?: string;
  readonly decision: "approved" | "rejected";
  readonly note?: string;
}

/** Nudge the loop without new user content (resume after an orchestrator event). */
export interface ContinueInput {
  readonly kind: "continue";
  readonly note?: string;
}

export type MasterInput =
  | UserMessageInput
  | ToolAnswerInput
  | ApprovalDecisionInput
  | ContinueInput;
