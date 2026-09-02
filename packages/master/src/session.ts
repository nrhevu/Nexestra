/**
 * `MasterSession` — one thread's conversation with the Master.
 *
 * `send()` returns an async iterable of `MasterEvent`, so the caller can stream
 * straight into a WebSocket. Inside, one `send()` is a loop: ask the model,
 * execute the tool calls it made, feed the results back, repeat until the model
 * stops or a tool hands control to the user.
 *
 * The invariants this file exists to hold:
 *
 * - The phase decides the tool surface; the model never chooses its own phase.
 * - Every `tool_use` input is re-validated against its zod schema before a host
 *   callback sees it, and a rejection comes back as a `tool_result` the model
 *   can recover from rather than as a thrown error.
 * - `response.content` is appended to history verbatim, so thinking and
 *   compaction blocks stay intact across turns.
 * - Every `tool_use` block in an assistant turn gets exactly one
 *   `tool_result`, including when the turn suspends waiting for the user.
 */
import type { Spec } from "@nexestra/core";
import type {
  MasterError,
  MasterEvent,
  MasterInput,
  MasterTurnOutcome,
  MasterUsageTotals,
} from "./events.js";
import type { MasterHost } from "./host.js";
import type { LlmClient, LlmMessage, LlmToolResultBlock, LlmToolUseBlock } from "./llm/types.js";
import {
  EMPTY_PHASE_CONTEXT,
  isToolAllowedInPhase,
  MASTER_TOOLS_BY_PHASE,
  nextPhase,
  type PhaseContext,
  type PhaseTransition,
  type PhaseTrigger,
} from "./phase.js";
import { applyReplan, buildPlanProposal } from "./plan.js";
import { loadPromptSet, type MasterPromptSet, systemPromptFor } from "./prompts/index.js";
import {
  addAskedQuestions,
  answerQuestions,
  applySpecPatch,
  createEmptySpec,
  renderSpec,
  unansweredQuestions,
  unverifiedCriteria,
} from "./spec.js";
import {
  createInMemoryMasterStore,
  type MasterStore,
  type MasterThreadState,
  type PendingToolCall,
  type PendingToolCallCore,
} from "./store.js";
import { getToolDefinition, toolsForPhase } from "./tools/definitions.js";
import {
  AskUserInputSchema,
  ControlRunInputSchema,
  DispatchTaskInputSchema,
  MarkCriterionInputSchema,
  ProposePlanInputSchema,
  ReadArtifactInputSchema,
  ReadRunEventsInputSchema,
  ReadWorkspaceInputSchema,
  RecordMemoryInputSchema,
  ReplanInputSchema,
  RequestApprovalInputSchema,
  RunVerificationInputSchema,
  SearchCodeInputSchema,
  SearchMemoryInputSchema,
  SummarizeInputSchema,
  UpdateSpecInputSchema,
} from "./tools/schemas.js";
import { addUsage, budgetState, toUsageTotals, ZERO_USAGE } from "./usage.js";

export interface MasterSessionConfig {
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly host: MasterHost;
  readonly llm: LlmClient;
  readonly store?: MasterStore;
  readonly budgetUSD?: number;
  readonly prompts?: MasterPromptSet;
  /** Stop rule from PLAN.md §4.1: at most this many questions per thread. */
  readonly maxQuestions?: number;
  /** Safety valve on the tool loop inside one `send()`. */
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  /** Advance `spec_frozen → planning` at the start of the next turn. Default on. */
  readonly autoAdvance?: boolean;
  readonly now?: () => string;
}

export interface MasterSession {
  readonly threadId: string;
  state(): Promise<MasterThreadState>;
  send(input: MasterInput | string): AsyncIterable<MasterEvent>;
  /** Push a transition from the orchestrator (plan accepted, tasks done…). */
  applyTrigger(trigger: PhaseTrigger): Promise<PhaseTransition>;
  /** Abort the in-flight model request. */
  cancel(): void;
}

const DEFAULT_MAX_QUESTIONS = 6;
const DEFAULT_MAX_ITERATIONS = 16;
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_BUDGET_USD = 20;

interface ToolOutcome {
  readonly result: LlmToolResultBlock;
  readonly events: readonly MasterEvent[];
  /** Set when the tool handed control to the user. */
  readonly suspend?: PendingToolCallCore | undefined;
}

function jsonResult(callId: string, value: unknown, isError = false): LlmToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: callId,
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { is_error: true } : {}),
  };
}

function errorResult(
  callId: string,
  message: string,
  extra?: Record<string, unknown>,
): ToolOutcome {
  return {
    result: jsonResult(callId, { error: message, ...extra }, true),
    events: [],
  };
}

function toPhaseContext(state: MasterThreadState): PhaseContext {
  if (!state.spec) return { ...EMPTY_PHASE_CONTEXT, specApproved: state.specApproved };
  return {
    openQuestionCount: unansweredQuestions(state.spec).length,
    acceptanceCriterionCount: state.spec.acceptanceCriteria.length,
    unverifiedCriterionCount: unverifiedCriteria(state.spec).length,
    specApproved: state.specApproved,
    planProposed: state.plan !== null,
  };
}

export function createMasterSession(config: MasterSessionConfig): MasterSession {
  const store = config.store ?? createInMemoryMasterStore();
  const prompts = config.prompts ?? loadPromptSet();
  const workspaceId = config.workspaceId ?? "default";
  const maxQuestions = config.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const autoAdvance = config.autoAdvance !== false;
  const now = config.now ?? (() => new Date().toISOString());

  let controller: AbortController | null = null;

  function initialState(): MasterThreadState {
    return {
      threadId: config.threadId,
      phase: "intake",
      spec: null,
      plan: null,
      specApproved: false,
      planAccepted: false,
      questionsAsked: 0,
      usage: ZERO_USAGE,
      budgetUSD: config.budgetUSD ?? DEFAULT_BUDGET_USD,
      budgetWarned: false,
      pending: null,
    };
  }

  async function load(): Promise<MasterThreadState> {
    return (await store.loadState(config.threadId)) ?? initialState();
  }

  function ensureSpec(state: MasterThreadState): Spec {
    return (
      state.spec ??
      createEmptySpec(
        { specId: `spec_${config.threadId}`, threadId: config.threadId, workspaceId },
        now(),
      )
    );
  }

  /* ------------------------------------------------------------- transitions */

  async function transition(
    state: MasterThreadState,
    trigger: PhaseTrigger,
  ): Promise<{ state: MasterThreadState; events: MasterEvent[]; transition: PhaseTransition }> {
    const result = nextPhase(state.phase, trigger, toPhaseContext(state));
    if (!result.ok || !result.changed) return { state, events: [], transition: result };
    const updated = { ...state, phase: result.to };
    await config.host.onPhaseChanged?.(result.from, result.to, result.reason);
    return {
      state: updated,
      events: [{ type: "phase_changed", from: result.from, to: result.to, reason: result.reason }],
      transition: result,
    };
  }

  /* ------------------------------------------------------------------ prompt */

  function renderContext(state: MasterThreadState): string {
    const lines: string[] = [
      "# Thread context",
      "",
      `phase: ${state.phase}`,
      `questions asked so far: ${state.questionsAsked} of ${maxQuestions}`,
      `budget: $${state.usage.costUSD.toFixed(4)} spent of $${state.budgetUSD.toFixed(2)}`,
      `spec approved: ${state.specApproved ? "yes" : "no"}`,
      "",
      "## Current spec",
      renderSpec(state.spec),
    ];
    if (state.plan) {
      lines.push("", `## Current plan (v${state.plan.version})`, state.plan.summary);
      for (const task of state.plan.tasks) {
        const dependencies = task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(", ")}` : "";
        lines.push(`  - [${task.id}] ${task.title} (${task.harness}${dependencies})`);
      }
    }
    return lines.join("\n");
  }

  /* ---------------------------------------------------------------- the loop */

  async function* runTurn(
    startState: MasterThreadState,
    initialMessages: readonly import("./llm/types.js").LlmMessageParam[],
  ): AsyncGenerator<MasterEvent, void, undefined> {
    let state = startState;
    if (initialMessages.length > 0) {
      await store.appendMessages(config.threadId, initialMessages);
    }

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const tools = toolsForPhase(state.phase, { cache: true });
      const history = await store.loadMessages(config.threadId);
      controller = new AbortController();

      let final: LlmMessage | null = null;
      try {
        for await (const event of config.llm.stream({
          system: systemPromptFor(state.phase, prompts),
          systemSuffix: renderContext(state),
          messages: history,
          tools,
          effort: state.phase === "planning" ? "high" : "medium",
          maxTokens,
          signal: controller.signal,
        })) {
          if (event.type === "text_delta") yield { type: "text_delta", text: event.text };
          else if (event.type === "thinking_delta") {
            yield { type: "thinking_summary", text: event.text };
          } else final = event.message;
        }
      } catch (cause) {
        const aborted = controller.signal.aborted;
        const error: MasterError = {
          code: aborted ? "internal" : "transport",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: !aborted,
        };
        await store.saveState(state);
        yield { type: "error", error };
        yield { type: "done", outcome: aborted ? "cancelled" : "error", phase: state.phase };
        return;
      } finally {
        controller = null;
      }

      if (!final) {
        await store.saveState(state);
        yield {
          type: "error",
          error: {
            code: "internal",
            message: "the model stream ended without a message",
            retryable: true,
          },
        };
        yield { type: "done", outcome: "error", phase: state.phase };
        return;
      }

      const turnUsage = toUsageTotals(final.usage, config.llm.model);
      state = { ...state, usage: addUsage(state.usage, turnUsage) };
      yield { type: "usage", turn: turnUsage, thread: state.usage, budgetUSD: state.budgetUSD };

      if (final.stop_reason === "refusal") {
        await store.saveState(state);
        yield {
          type: "error",
          error: {
            code: "refusal",
            message: final.stop_details?.explanation ?? "the model declined this request",
            category: final.stop_details?.category ?? null,
            retryable: false,
          },
        };
        yield { type: "done", outcome: "error", phase: state.phase };
        return;
      }

      if (
        final.stop_reason === "max_tokens" ||
        final.stop_reason === "model_context_window_exceeded"
      ) {
        await store.saveState(state);
        yield {
          type: "error",
          error: {
            code: final.stop_reason === "max_tokens" ? "max_tokens" : "context_window_exceeded",
            message: `the turn stopped on \`${final.stop_reason}\``,
            retryable: true,
          },
        };
        yield { type: "done", outcome: "error", phase: state.phase };
        return;
      }

      // Verbatim: thinking and compaction blocks must survive the round-trip.
      await store.appendMessages(config.threadId, [{ role: "assistant", content: final.content }]);

      const budget = budgetState(state.usage, state.budgetUSD);
      if (budget === "exceeded") {
        const blocked = await transition(state, { type: "blocked", reason: "budget exceeded" });
        state = blocked.state;
        await store.saveState(state);
        yield* blocked.events;
        yield {
          type: "error",
          error: {
            code: "budget",
            message: `thread budget of $${state.budgetUSD.toFixed(2)} is spent`,
            retryable: false,
          },
        };
        yield { type: "done", outcome: "budget_exceeded", phase: state.phase };
        return;
      }
      if (budget === "warning" && !state.budgetWarned) {
        state = { ...state, budgetWarned: true };
        const request = {
          kind: "spend" as const,
          summary: `Spent $${state.usage.costUSD.toFixed(2)} of the $${state.budgetUSD.toFixed(2)} thread budget.`,
        };
        try {
          const approval = await config.host.requestApproval(request);
          yield { type: "approval_requested", approval, request };
        } catch {
          /* a host that cannot raise approvals should not break the turn */
        }
      }

      const toolUses = final.content.filter(
        (block): block is LlmToolUseBlock => block.type === "tool_use",
      );

      if (final.stop_reason === "pause_turn" || final.stop_reason === "compaction") {
        // The server paused mid-turn (server tool loop / compaction). Resume.
        await store.saveState(state);
        continue;
      }

      if (toolUses.length === 0) {
        await store.saveState(state);
        yield { type: "done", outcome: "end_turn", phase: state.phase };
        return;
      }

      const results: LlmToolResultBlock[] = [];
      let suspended: PendingToolCall | null = null;

      for (const [index, use] of toolUses.entries()) {
        if (suspended) {
          results.push(
            jsonResult(use.id, { error: "not executed: the turn is waiting for the user" }, true),
          );
          continue;
        }
        yield { type: "tool_call", callId: use.id, name: use.name, input: use.input };
        const outcome = await executeTool(state, use);
        state = outcome.state;
        yield* outcome.events;
        yield {
          type: "tool_result",
          callId: use.id,
          name: use.name,
          ok: outcome.result.is_error !== true,
          output: outcome.result.content,
        };
        if (outcome.suspend) {
          void index;
          suspended = { ...outcome.suspend, resultsBefore: [...results], resultsAfter: [] };
        } else {
          results.push(outcome.result);
        }
      }

      if (suspended) {
        const after = results.slice(suspended.resultsBefore.length);
        const pending: PendingToolCall = { ...suspended, resultsAfter: after };
        state = { ...state, pending };
        await store.saveState(state);
        yield {
          type: "done",
          outcome: suspended.kind === "ask_user" ? "awaiting_answers" : "awaiting_approval",
          phase: state.phase,
        };
        return;
      }

      await store.appendMessages(config.threadId, [{ role: "user", content: results }]);
      await store.saveState(state);
    }

    await store.saveState(state);
    yield {
      type: "error",
      error: {
        code: "internal",
        message: `the turn made ${maxIterations} model calls without finishing`,
        retryable: true,
      },
    };
    yield { type: "done", outcome: "max_iterations", phase: state.phase };
  }

  /* ------------------------------------------------------------ tool dispatch */

  async function executeTool(
    state: MasterThreadState,
    use: LlmToolUseBlock,
  ): Promise<ToolOutcome & { state: MasterThreadState }> {
    const definition = getToolDefinition(use.name);
    if (!definition) {
      return { ...errorResult(use.id, `unknown tool \`${use.name}\``), state };
    }
    if (!isToolAllowedInPhase(state.phase, use.name)) {
      return {
        ...errorResult(
          use.id,
          `tool \`${use.name}\` is not available in phase \`${state.phase}\``,
          { availableTools: [...MASTER_TOOLS_BY_PHASE[state.phase]] },
        ),
        state,
      };
    }

    try {
      return await dispatch(state, use);
    } catch (cause) {
      return {
        ...errorResult(use.id, cause instanceof Error ? cause.message : String(cause)),
        state,
      };
    }
  }

  async function dispatch(
    state: MasterThreadState,
    use: LlmToolUseBlock,
  ): Promise<ToolOutcome & { state: MasterThreadState }> {
    const callId = use.id;
    const timestamp = now();

    switch (use.name) {
      case "read_workspace": {
        const parsed = ReadWorkspaceInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.readWorkspace(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      case "search_code": {
        const parsed = SearchCodeInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.searchCode(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      case "search_memory": {
        const parsed = SearchMemoryInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.searchMemory(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      case "ask_user": {
        const parsed = AskUserInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const asked = state.questionsAsked + parsed.data.questions.length;
        if (state.questionsAsked >= maxQuestions) {
          return {
            ...errorResult(
              callId,
              `you have already asked ${state.questionsAsked} of ${maxQuestions} questions; ` +
                "fill the remaining gaps with stated assumptions and propose the spec",
            ),
            state,
          };
        }
        const spec = addAskedQuestions(ensureSpec(state), parsed.data.questions, timestamp);
        await config.host.onSpecUpdated?.(spec);
        let updated: MasterThreadState = { ...state, spec, questionsAsked: asked };
        const events: MasterEvent[] = [{ type: "spec_updated", spec }];
        const moved = await transition(updated, { type: "clarification_started" });
        updated = moved.state;
        events.push(...moved.events);
        events.push({ type: "question", callId, questions: parsed.data.questions });
        return {
          result: jsonResult(callId, { asked: parsed.data.questions.map((q) => q.id) }),
          events,
          suspend: { kind: "ask_user", callId, questions: parsed.data.questions },
          state: updated,
        };
      }

      case "update_spec": {
        const parsed = UpdateSpecInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const spec = applySpecPatch(ensureSpec(state), parsed.data.patch, timestamp);
        await config.host.onSpecUpdated?.(spec);
        let updated: MasterThreadState = { ...state, spec };
        const events: MasterEvent[] = [{ type: "spec_updated", spec }];
        const moved = await transition(updated, { type: "clarification_started" });
        updated = moved.state;
        events.push(...moved.events);
        const open = unansweredQuestions(spec);
        return {
          result: jsonResult(callId, {
            version: spec.version,
            acceptanceCriteria: spec.acceptanceCriteria.length,
            openQuestions: open.map((question) => question.id),
          }),
          events,
          state: updated,
        };
      }

      case "record_memory": {
        const parsed = RecordMemoryInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const memory = await config.host.recordMemory(parsed.data);
        return { result: jsonResult(callId, { memoryId: memory.id }), events: [], state };
      }

      case "request_approval": {
        const parsed = RequestApprovalInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        if (parsed.data.kind === "spec") {
          const open = unansweredQuestions(state.spec);
          if (open.length > 0) {
            return {
              ...errorResult(
                callId,
                `${open.length} question(s) are still unanswered; the spec cannot be approved yet`,
                { openQuestionIds: open.map((question) => question.id) },
              ),
              state,
            };
          }
          if ((state.spec?.acceptanceCriteria.length ?? 0) < 1) {
            return {
              ...errorResult(callId, "the spec has no acceptance criteria; add at least one first"),
              state,
            };
          }
        }
        const approval = await config.host.requestApproval(parsed.data);
        const events: MasterEvent[] = [
          { type: "approval_requested", callId, approval, request: parsed.data },
        ];
        if (approval.status === "pending") {
          return {
            result: jsonResult(callId, { approvalId: approval.approvalId, status: "pending" }),
            events,
            suspend: {
              kind: "request_approval",
              callId,
              approvalId: approval.approvalId,
              request: parsed.data,
            },
            state,
          };
        }
        const resolved = await resolveApproval(
          state,
          parsed.data.kind,
          approval.status === "approved" ? "approved" : "rejected",
        );
        return {
          result: jsonResult(callId, { approvalId: approval.approvalId, status: approval.status }),
          events: [...events, ...resolved.events],
          state: resolved.state,
        };
      }

      case "propose_plan": {
        const parsed = ProposePlanInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const gate = planGate(state);
        if (gate) return { ...errorResult(callId, gate), state };
        const spec = state.spec;
        if (!spec) return { ...errorResult(callId, "there is no spec to plan against"), state };
        const validation = buildPlanProposal(parsed.data, spec, (state.plan?.version ?? 0) + 1);
        if (!validation.ok) {
          return {
            ...errorResult(callId, "the plan is not valid", { issues: validation.issues }),
            state,
          };
        }
        await config.host.onPlanProposed?.(validation.plan);
        return {
          result: jsonResult(callId, {
            version: validation.plan.version,
            tasks: validation.plan.tasks.length,
            edges: validation.plan.edges.length,
          }),
          events: [{ type: "plan_proposed", plan: validation.plan }],
          state: { ...state, plan: validation.plan },
        };
      }

      case "replan": {
        const parsed = ReplanInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        if (!state.plan || !state.spec) {
          return { ...errorResult(callId, "there is no plan to amend"), state };
        }
        const validation = applyReplan(state.plan, parsed.data, state.spec);
        if (!validation.ok) {
          return {
            ...errorResult(callId, "the amended plan is not valid", { issues: validation.issues }),
            state,
          };
        }
        await config.host.onPlanProposed?.(validation.plan);
        return {
          result: jsonResult(callId, {
            version: validation.plan.version,
            tasks: validation.plan.tasks.length,
          }),
          events: [{ type: "plan_proposed", plan: validation.plan }],
          state: { ...state, plan: validation.plan },
        };
      }

      case "dispatch_task": {
        const parsed = DispatchTaskInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.dispatchTask(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      case "read_run_events": {
        const parsed = ReadRunEventsInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.readRunEvents(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      case "read_artifact": {
        const parsed = ReadArtifactInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.readArtifact(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      case "control_run": {
        const parsed = ControlRunInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        if (parsed.data.action === "steer" && !parsed.data.message) {
          return { ...errorResult(callId, "`steer` needs a `message`"), state };
        }
        const result = await config.host.controlRun(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      case "run_verification": {
        const parsed = RunVerificationInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.runVerification(parsed.data);
        const spec = state.spec;
        if (!spec) return { result: jsonResult(callId, result), events: [], state };
        const criteria = spec.acceptanceCriteria.map((criterion) => {
          const outcome = result.outcomes.find((entry) => entry.criterionId === criterion.id);
          if (!outcome?.passed || !outcome.evidenceArtifactId) return criterion;
          return { ...criterion, satisfied: true, evidenceArtifactId: outcome.evidenceArtifactId };
        });
        const updatedSpec: Spec = { ...spec, acceptanceCriteria: criteria, updatedAt: timestamp };
        await config.host.onSpecUpdated?.(updatedSpec);
        return {
          result: jsonResult(callId, result),
          events: [{ type: "spec_updated", spec: updatedSpec }],
          state: { ...state, spec: updatedSpec },
        };
      }

      case "mark_criterion": {
        const parsed = MarkCriterionInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        if (parsed.data.passed && !parsed.data.evidenceArtifactId) {
          return {
            ...errorResult(
              callId,
              "a passing criterion needs an `evidenceArtifactId` produced by run_verification",
            ),
            state,
          };
        }
        const result = await config.host.markCriterion(parsed.data);
        const spec = state.spec;
        if (!spec) return { result: jsonResult(callId, result), events: [], state };
        const criteria = spec.acceptanceCriteria.map((criterion) =>
          criterion.id === parsed.data.criterionId
            ? {
                ...criterion,
                satisfied: parsed.data.passed,
                ...(parsed.data.evidenceArtifactId
                  ? { evidenceArtifactId: parsed.data.evidenceArtifactId }
                  : {}),
              }
            : criterion,
        );
        const updatedSpec: Spec = { ...spec, acceptanceCriteria: criteria, updatedAt: timestamp };
        await config.host.onSpecUpdated?.(updatedSpec);
        return {
          result: jsonResult(callId, result),
          events: [{ type: "spec_updated", spec: updatedSpec }],
          state: { ...state, spec: updatedSpec },
        };
      }

      case "summarize": {
        const parsed = SummarizeInputSchema.safeParse(use.input);
        if (!parsed.success) return { ...invalid(callId, parsed.error), state };
        const result = await config.host.summarize(parsed.data);
        return { result: jsonResult(callId, result), events: [], state };
      }

      default:
        return { ...errorResult(callId, `unhandled tool \`${use.name}\``), state };
    }
  }

  function invalid(callId: string, error: { issues: readonly unknown[] }): ToolOutcome {
    return errorResult(callId, "the tool input failed schema validation", { issues: error.issues });
  }

  function planGate(state: MasterThreadState): string | null {
    if (!state.spec) return "there is no spec yet";
    const open = unansweredQuestions(state.spec);
    if (open.length > 0) {
      return `${open.length} open question(s) remain (${open
        .map((question) => question.id)
        .join(", ")}); the spec must be complete before planning`;
    }
    if (!state.specApproved) return "the spec has not been approved by the user yet";
    if (state.spec.acceptanceCriteria.length < 1) return "the spec has no acceptance criteria";
    return null;
  }

  async function resolveApproval(
    state: MasterThreadState,
    kind: string,
    decision: "approved" | "rejected",
  ): Promise<{ state: MasterThreadState; events: MasterEvent[] }> {
    if (kind !== "spec") return { state, events: [] };
    if (decision === "rejected") {
      return { state, events: [] };
    }
    const approved: MasterThreadState = {
      ...state,
      specApproved: true,
      spec: state.spec ? { ...state.spec, frozen: true } : null,
    };
    if (approved.spec) await config.host.onSpecUpdated?.(approved.spec);
    const moved = await transition(approved, { type: "spec_approved" });
    const events: MasterEvent[] = approved.spec
      ? [{ type: "spec_updated", spec: approved.spec }]
      : [];
    return { state: moved.state, events: [...events, ...moved.events] };
  }

  /* ------------------------------------------------------------------- input */

  async function prepare(
    state: MasterThreadState,
    input: MasterInput,
  ): Promise<{
    state: MasterThreadState;
    messages: import("./llm/types.js").LlmMessageParam[];
    events: MasterEvent[];
    reject?: MasterError;
  }> {
    const events: MasterEvent[] = [];
    const pending = state.pending;
    const timestamp = now();

    if (pending) {
      let resolvedResult: LlmToolResultBlock;
      let updated = { ...state, pending: null } as MasterThreadState;

      if (pending.kind === "ask_user") {
        const answers =
          input.kind === "answers"
            ? input.answers
            : input.kind === "user_message"
              ? pending.questions.map((question, index) => ({
                  id: question.id,
                  // A free-text reply answers the first question; the rest stay open
                  // unless the user only had one.
                  answer: index === 0 ? input.text : "",
                }))
              : [];
        const real = answers.filter((answer) => answer.answer.length > 0);
        const spec = state.spec ? answerQuestions(state.spec, real, timestamp) : null;
        if (spec) {
          await config.host.onSpecUpdated?.(spec);
          events.push({ type: "spec_updated", spec });
        }
        updated = { ...updated, spec };
        resolvedResult = jsonResult(pending.callId, { answers: real });
      } else if (input.kind === "approval") {
        const resolved = await resolveApproval(updated, pending.request.kind, input.decision);
        updated = resolved.state;
        events.push(...resolved.events);
        resolvedResult = jsonResult(pending.callId, {
          approvalId: pending.approvalId,
          status: input.decision,
          ...(input.note ? { note: input.note } : {}),
        });
      } else if (input.kind === "user_message") {
        // The user answered an approval request in prose. Treat it as text the
        // Master has to interpret, and leave the approval unresolved.
        resolvedResult = jsonResult(pending.callId, {
          approvalId: pending.approvalId,
          status: "pending",
          userReply: input.text,
        });
      } else {
        return {
          state,
          messages: [],
          events,
          reject: {
            code: "phase",
            message: `the thread is waiting for an approval on \`${pending.callId}\``,
            retryable: false,
          },
        };
      }

      const content: LlmToolResultBlock[] = [
        ...pending.resultsBefore,
        resolvedResult,
        ...pending.resultsAfter,
      ];
      const messages: import("./llm/types.js").LlmMessageParam[] = [{ role: "user", content }];
      if (input.kind === "user_message") {
        messages.push({ role: "user", content: input.text });
      }
      return { state: updated, messages, events };
    }

    if (input.kind === "user_message") {
      return { state, messages: [{ role: "user", content: input.text }], events };
    }
    if (input.kind === "continue") {
      return {
        state,
        messages: [{ role: "user", content: input.note ?? "Continue." }],
        events,
      };
    }
    return {
      state,
      messages: [],
      events,
      reject: {
        code: "phase",
        message: `nothing is waiting for \`${input.kind}\``,
        retryable: false,
      },
    };
  }

  /* ------------------------------------------------------------------ public */

  async function* send(raw: MasterInput | string): AsyncGenerator<MasterEvent, void, undefined> {
    const input: MasterInput = typeof raw === "string" ? { kind: "user_message", text: raw } : raw;
    let state = await load();

    if (state.phase === "cancelled") {
      yield {
        type: "error",
        error: { code: "phase", message: "this thread is cancelled", retryable: false },
      };
      yield { type: "done", outcome: "cancelled", phase: state.phase };
      return;
    }

    // Captured before `prepare`, so an approval that freezes the spec *during*
    // this turn still gets its `spec_frozen` wrap-up; planning starts next turn.
    const phaseAtEntry = state.phase;
    const prepared = await prepare(state, input);
    state = prepared.state;
    yield* prepared.events;
    if (prepared.reject) {
      await store.saveState(state);
      yield { type: "error", error: prepared.reject };
      yield { type: "done", outcome: "error", phase: state.phase };
      return;
    }

    if (autoAdvance && phaseAtEntry === "spec_frozen" && state.phase === "spec_frozen") {
      const moved = await transition(state, { type: "planning_started" });
      state = moved.state;
      yield* moved.events;
    }

    yield* runTurn(state, prepared.messages);
  }

  return {
    threadId: config.threadId,
    async state() {
      return load();
    },
    send,
    async applyTrigger(trigger) {
      const state = await load();
      const moved = await transition(state, trigger);
      if (moved.transition.ok) {
        const withFlags =
          trigger.type === "plan_accepted" ? { ...moved.state, planAccepted: true } : moved.state;
        await store.saveState(withFlags);
      }
      return moved.transition;
    },
    cancel() {
      controller?.abort();
    },
  };
}

export type { MasterTurnOutcome, MasterUsageTotals };
