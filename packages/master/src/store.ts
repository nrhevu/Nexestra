/**
 * `MasterStore` — where a thread's conversation and derived state live.
 *
 * Deliberately tiny. The conversation is append-only: the session pushes the
 * user turn and then `response.content` **verbatim**, so thinking blocks and
 * compaction blocks survive and the API can keep using them. Anything that
 * rewrites history would break both.
 *
 * `packages/storage` implements this over the event store in M1/M3; the
 * in-memory version here is what the tests and a fresh dev server use.
 */
import type { Spec, ThreadPhase } from "@nexestra/core";
import type { MasterUsageTotals } from "./events.js";
import type { LlmMessageParam, LlmToolResultBlock } from "./llm/types.js";
import type { MasterPlanProposal } from "./plan.js";
import type { AskUserQuestion, RequestApprovalInput } from "./tools/schemas.js";

/**
 * A tool call that handed control back to the user and is waiting on them.
 *
 * `resultsBefore` / `resultsAfter` hold the tool results for the *other* calls
 * in the same assistant turn. The API requires every `tool_use` block to be
 * answered in one user message, so the session parks them here and splices the
 * resolved result into the middle when the user replies.
 */
export type PendingToolCallCore =
  | {
      readonly kind: "ask_user";
      readonly callId: string;
      readonly questions: readonly AskUserQuestion[];
    }
  | {
      readonly kind: "request_approval";
      readonly callId: string;
      readonly approvalId: string;
      readonly request: RequestApprovalInput;
    };

export type PendingToolCall = PendingToolCallCore & {
  readonly resultsBefore: readonly LlmToolResultBlock[];
  readonly resultsAfter: readonly LlmToolResultBlock[];
};

export interface MasterThreadState {
  readonly threadId: string;
  readonly phase: ThreadPhase;
  readonly spec: Spec | null;
  readonly plan: MasterPlanProposal | null;
  readonly specApproved: boolean;
  readonly planAccepted: boolean;
  /** How many questions the Master has asked in total (stop rule). */
  readonly questionsAsked: number;
  readonly usage: MasterUsageTotals;
  readonly budgetUSD: number;
  /** True once the 80% spend approval has been raised, so it fires once. */
  readonly budgetWarned: boolean;
  readonly pending: PendingToolCall | null;
}

export interface MasterStore {
  loadState(threadId: string): Promise<MasterThreadState | null>;
  saveState(state: MasterThreadState): Promise<void>;
  /** Append turns verbatim. Never rewrites earlier entries. */
  appendMessages(threadId: string, messages: readonly LlmMessageParam[]): Promise<void>;
  loadMessages(threadId: string): Promise<LlmMessageParam[]>;
}

export function createInMemoryMasterStore(): MasterStore & {
  /** Test helper: raw view of what was persisted. */
  readonly snapshot: () => Readonly<Record<string, LlmMessageParam[]>>;
} {
  const states = new Map<string, MasterThreadState>();
  const messages = new Map<string, LlmMessageParam[]>();

  return {
    async loadState(threadId) {
      return states.get(threadId) ?? null;
    },
    async saveState(state) {
      states.set(state.threadId, state);
    },
    async appendMessages(threadId, incoming) {
      const existing = messages.get(threadId) ?? [];
      existing.push(...incoming);
      messages.set(threadId, existing);
    },
    async loadMessages(threadId) {
      return [...(messages.get(threadId) ?? [])];
    },
    snapshot() {
      return Object.fromEntries([...messages.entries()].map(([id, list]) => [id, [...list]]));
    },
  };
}
