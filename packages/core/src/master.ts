import { z } from "zod";
import { IdSchema } from "./domain/common.js";
import { SpecSchema } from "./domain/spec.js";
import { ThreadPhaseSchema } from "./domain/thread.js";

/**
 * The wire shapes of the Master runtime (M3).
 *
 * `packages/master` owns the agent; this file owns what crosses the process
 * boundary, so `apps/server` and `apps/web` agree without the browser bundle
 * having to import the agent (and, through it, the Anthropic SDK). The shapes
 * mirror `MasterEvent` / `MasterInput` from `@nexestra/master`; the mirroring
 * is deliberate — core cannot depend on master, because master depends on core.
 */

/* --------------------------------------------------------------- primitives */

export const MasterTurnOutcomeSchema = z.enum([
  "end_turn",
  "awaiting_answers",
  "awaiting_approval",
  "max_iterations",
  "budget_exceeded",
  "cancelled",
  "error",
]);
export type MasterTurnOutcome = z.infer<typeof MasterTurnOutcomeSchema>;

export const MasterErrorCodeSchema = z.enum([
  "refusal",
  "max_tokens",
  "context_window_exceeded",
  "transport",
  "tool",
  "phase",
  "budget",
  "internal",
]);
export type MasterErrorCode = z.infer<typeof MasterErrorCodeSchema>;

export const MasterErrorSchema = z.object({
  code: MasterErrorCodeSchema,
  message: z.string(),
  category: z.string().nullish(),
  retryable: z.boolean(),
});
export type MasterError = z.infer<typeof MasterErrorSchema>;

/** One question from `ask_user`, rendered as an inline card in Chat. */
export const MasterQuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  options: z.array(z.string()).default([]),
  allowFreeText: z.boolean().default(true),
});
export type MasterQuestion = z.infer<typeof MasterQuestionSchema>;

export const MasterUsageTotalsSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  costUSD: z.number().nonnegative(),
});
export type MasterUsageTotals = z.infer<typeof MasterUsageTotalsSchema>;

/* ------------------------------------------------------------ event payloads */

/** Fields every `master.*` event payload carries. */
const MasterEventBase = {
  threadId: IdSchema,
  /** Groups every event of one `send()`; the Chat surface folds on it. */
  turnId: z.string().min(1),
};

export const MasterStreamPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    ...MasterEventBase,
    type: z.literal("master.started"),
    phase: ThreadPhaseSchema,
    /** What kicked the turn off, for the "Master is thinking" hint. */
    trigger: z.enum(["user_message", "answers", "approval", "continue"]),
  }),
  z.object({ ...MasterEventBase, type: z.literal("master.text_delta"), text: z.string() }),
  z.object({
    ...MasterEventBase,
    type: z.literal("master.tool_call"),
    callId: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    ...MasterEventBase,
    type: z.literal("master.tool_result"),
    callId: z.string().min(1),
    name: z.string().min(1),
    ok: z.boolean(),
    output: z.unknown(),
  }),
  z.object({
    ...MasterEventBase,
    type: z.literal("master.question"),
    callId: z.string().min(1),
    questions: z.array(MasterQuestionSchema),
  }),
  z.object({
    ...MasterEventBase,
    type: z.literal("master.usage"),
    turn: MasterUsageTotalsSchema,
    thread: MasterUsageTotalsSchema,
    budgetUSD: z.number().nonnegative(),
  }),
  z.object({ ...MasterEventBase, type: z.literal("master.error"), error: MasterErrorSchema }),
  z.object({
    ...MasterEventBase,
    type: z.literal("master.done"),
    outcome: MasterTurnOutcomeSchema,
    phase: ThreadPhaseSchema,
  }),
]);
export type MasterStreamPayload = z.infer<typeof MasterStreamPayloadSchema>;

/* ------------------------------------------------------------------ requests */

/** `POST /api/threads/:id/master/send` — mirrors `MasterInput`. */
export const MasterSendRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_message"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("answers"),
    callId: z.string().min(1).optional(),
    answers: z.array(z.object({ id: z.string().min(1), answer: z.string() })).min(1),
  }),
  z.object({
    kind: z.literal("approval"),
    callId: z.string().min(1).optional(),
    approvalId: IdSchema.optional(),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().optional(),
  }),
  z.object({ kind: z.literal("continue"), note: z.string().optional() }),
]);
export type MasterSendRequest = z.infer<typeof MasterSendRequestSchema>;

/** `POST /api/threads/:id/master/send` — the turn runs in the background. */
export const MasterSendResponseSchema = z.object({
  threadId: IdSchema,
  turnId: z.string().min(1),
  accepted: z.literal(true),
});
export type MasterSendResponse = z.infer<typeof MasterSendResponseSchema>;

/* ------------------------------------------------------------------- state */

/** What the turn is waiting on, so a reload can re-render the right card. */
export const MasterPendingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ask_user"),
    callId: z.string().min(1),
    questions: z.array(MasterQuestionSchema),
  }),
  z.object({
    kind: z.literal("request_approval"),
    callId: z.string().min(1),
    approvalId: IdSchema,
    summary: z.string(),
  }),
]);
export type MasterPending = z.infer<typeof MasterPendingSchema>;

/** Which model client the server actually runs on. Never carries the key. */
export const MasterRuntimeInfoSchema = z.object({
  client: z.enum(["anthropic", "demo"]),
  model: z.string(),
  /** True when `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set. */
  apiKeyPresent: z.boolean(),
});
export type MasterRuntimeInfo = z.infer<typeof MasterRuntimeInfoSchema>;

/** `GET /api/threads/:id/master/state` */
export const MasterStateResponseSchema = z.object({
  threadId: IdSchema,
  phase: ThreadPhaseSchema,
  /** True while a turn is in flight; the composer disables itself on it. */
  busy: z.boolean(),
  turnId: z.string().nullable(),
  pending: MasterPendingSchema.nullable(),
  spec: SpecSchema.nullable(),
  specApproved: z.boolean(),
  planAccepted: z.boolean(),
  questionsAsked: z.number().int().nonnegative(),
  maxQuestions: z.number().int().positive(),
  usage: MasterUsageTotalsSchema,
  budgetUSD: z.number().nonnegative(),
  lastOutcome: MasterTurnOutcomeSchema.nullable(),
  runtime: MasterRuntimeInfoSchema,
});
export type MasterStateResponse = z.infer<typeof MasterStateResponseSchema>;

/** `POST /api/threads/:id/master/cancel` */
export const MasterCancelResponseSchema = z.object({
  threadId: IdSchema,
  cancelled: z.boolean(),
});
export type MasterCancelResponse = z.infer<typeof MasterCancelResponseSchema>;
