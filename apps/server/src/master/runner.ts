/**
 * `MasterRunner` — the Master, wired into the server.
 *
 * One live `MasterSession` per thread, one turn at a time per thread, and
 * every `MasterEvent` narrated onto the thread's event log so the existing
 * WebSocket carries it to the Chat surface without a second transport.
 *
 * The four things this file is responsible for:
 *
 * 1. **Serialisation.** Turns for one thread are chained onto a promise, so a
 *    second `send()` (a fast typist, or an approval arriving mid-turn) queues
 *    instead of interleaving two model loops over the same history. Different
 *    threads run concurrently.
 * 2. **Narration.** `MasterEvent` → `master.*` store events. Text deltas are
 *    coalesced into ~80-character chunks: a row per token would multiply the
 *    log by two orders of magnitude for no visible difference.
 * 3. **The transcript.** A turn ends with one `master` `Message` carrying the
 *    assistant's text, its tool calls and (when it proposed one) a plan
 *    preview. That is what survives a reload; the `master.*` events are the
 *    live view of a turn in flight.
 * 4. **Cost.** Thread usage is accumulated into `Thread.costUSD` — the column
 *    the header and the budget rules already read.
 *
 * Spec approval auto-continues: a turn that ends in `spec_frozen` is followed
 * by a `continue`, which is what moves the thread into `planning` and gets the
 * plan proposed without the user having to prod it.
 */
import type {
  MasterPending,
  MasterRuntimeInfo,
  MasterSendRequest,
  MasterStateResponse,
  MasterUsageTotals,
  MessageAttachment,
  MessageToolCall,
  ThreadPhase,
} from "@nexestra/core";
import type {
  LlmClient,
  MasterEvent,
  MasterInput,
  MasterPromptSet,
  MasterSession,
  MasterThreadState,
  MasterTurnOutcome,
} from "@nexestra/master";
import { createMasterSession } from "@nexestra/master";
import { type NexestraStore, NotFoundError, newId } from "@nexestra/storage";
import { createNotYetAvailableExecutionHost, type ExecutionHost } from "./execution-host.js";
import { createServerMasterHost } from "./host.js";
import { loadServerPromptSet } from "./prompts.js";
import { createStorageMasterStore } from "./store.js";

/** Flush the text buffer once it is worth an event of its own. */
const TEXT_FLUSH_CHARS = 80;

/** Guard on the auto-continue chain, so a loop cannot run away. */
const MAX_AUTO_CONTINUE_STEPS = 3;

export interface MasterRunnerOptions {
  readonly store: NexestraStore;
  readonly llm: LlmClient;
  readonly runtime: MasterRuntimeInfo;
  /** Defaults to `NotYetAvailableExecutionHost` until the orchestrator lands. */
  readonly execution?: ExecutionHost;
  readonly prompts?: MasterPromptSet;
  readonly maxQuestions?: number;
  /** Continue into `planning` on its own once the spec is approved. */
  readonly autoContinue?: boolean;
}

interface TurnResult {
  readonly outcome: MasterTurnOutcome;
  readonly phase: ThreadPhase;
}

export class MasterRunner {
  private readonly sessions = new Map<string, MasterSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly turns = new Map<string, string>();
  private readonly outcomes = new Map<string, MasterTurnOutcome>();
  private readonly maxQuestions: number;
  private readonly execution: ExecutionHost;
  private readonly autoContinue: boolean;
  private prompts: MasterPromptSet | undefined;

  constructor(private readonly options: MasterRunnerOptions) {
    this.maxQuestions = options.maxQuestions ?? 6;
    this.execution = options.execution ?? createNotYetAvailableExecutionHost();
    this.autoContinue = options.autoContinue !== false;
    this.prompts = options.prompts;
  }

  get runtime(): MasterRuntimeInfo {
    return this.options.runtime;
  }

  isBusy(threadId: string): boolean {
    return this.busy.has(threadId);
  }

  /**
   * Queue a turn. Returns as soon as it is accepted — the turn itself streams
   * over `/ws`, so an HTTP client is never held open for a model call.
   */
  send(threadId: string, input: MasterSendRequest): { turnId: string } {
    const thread = this.options.store.getThread(threadId);
    if (!thread) throw new NotFoundError("thread", threadId);

    const turnId = newId("turn");
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.runChain(threadId, input as MasterInput, turnId));
    this.queues.set(
      threadId,
      next.catch((error) => {
        process.stderr.write(`master turn failed on ${threadId}: ${String(error)}\n`);
      }),
    );
    return { turnId };
  }

  /** Abort the in-flight model request, if there is one. */
  cancel(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session || !this.busy.has(threadId)) return false;
    session.cancel();
    return true;
  }

  /** Resolve when the thread's queue has drained. Used by tests and shutdown. */
  async idle(threadId: string): Promise<void> {
    await this.queues.get(threadId)?.catch(() => undefined);
  }

  async state(threadId: string): Promise<MasterStateResponse> {
    const thread = this.options.store.getThread(threadId);
    if (!thread) throw new NotFoundError("thread", threadId);
    const state = await this.sessionFor(threadId).state();

    return {
      threadId,
      phase: state.phase,
      busy: this.busy.has(threadId),
      turnId: this.turns.get(threadId) ?? null,
      pending: toPendingResponse(state),
      spec: this.options.store.getSpec(threadId),
      specApproved: state.specApproved,
      planAccepted: state.planAccepted,
      questionsAsked: state.questionsAsked,
      maxQuestions: this.maxQuestions,
      usage: state.usage,
      budgetUSD: state.budgetUSD,
      lastOutcome: this.outcomes.get(threadId) ?? null,
      runtime: this.options.runtime,
    };
  }

  /**
   * Resume a turn suspended on `request_approval`.
   *
   * Called from `POST /api/approvals/:id/resolve`, so the same button that
   * resolves the approval entity also unblocks the Master. Approvals the
   * Master raised on its own (the 80% budget warning) do not suspend a turn
   * and are ignored here.
   */
  async resumeApproval(
    threadId: string,
    approvalId: string,
    decision: "approved" | "rejected",
    note?: string,
  ): Promise<boolean> {
    if (!this.options.store.getThread(threadId)) return false;
    const state = await this.sessionFor(threadId).state();
    if (state.pending?.kind !== "request_approval") return false;
    if (state.pending.approvalId !== approvalId) return false;

    this.send(threadId, {
      kind: "approval",
      approvalId,
      decision,
      ...(note ? { note } : {}),
    });
    return true;
  }

  /** Drop cached sessions; the next `send()` rebuilds from the store. */
  reset(threadId?: string): void {
    if (threadId) this.sessions.delete(threadId);
    else this.sessions.clear();
  }

  /* --------------------------------------------------------------- internals */

  private sessionFor(threadId: string): MasterSession {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;

    const { store } = this.options;
    const thread = store.getThread(threadId);
    if (!thread) throw new NotFoundError("thread", threadId);
    const workspace = store.getWorkspace(thread.workspaceId);
    if (!workspace) throw new NotFoundError("workspace", thread.workspaceId);

    this.prompts ??= loadServerPromptSet();

    const session = createMasterSession({
      threadId,
      workspaceId: thread.workspaceId,
      host: createServerMasterHost({
        store,
        workspaceId: thread.workspaceId,
        threadId,
        workspacePath: workspace.rootPath,
        execution: this.execution,
      }),
      llm: this.options.llm,
      store: createStorageMasterStore(store),
      budgetUSD: thread.budgetUSD,
      prompts: this.prompts,
      maxQuestions: this.maxQuestions,
    });
    this.sessions.set(threadId, session);
    return session;
  }

  /** One user action, plus any auto-continue steps it triggers. */
  private async runChain(threadId: string, input: MasterInput, turnId: string): Promise<void> {
    const { store } = this.options;
    const thread = store.getThread(threadId);
    if (!thread) return;

    this.busy.add(threadId);
    this.turns.set(threadId, turnId);
    this.emit(threadId, {
      type: "master.started",
      threadId,
      turnId,
      phase: thread.phase,
      trigger: input.kind,
    });

    try {
      let current = input;
      for (let step = 0; step < MAX_AUTO_CONTINUE_STEPS; step += 1) {
        await this.recordUserSide(threadId, current);
        const result = await this.runTurn(threadId, current, turnId);
        this.outcomes.set(threadId, result.outcome);

        const shouldContinue =
          this.autoContinue && result.outcome === "end_turn" && result.phase === "spec_frozen";
        if (!shouldContinue) {
          this.emit(threadId, {
            type: "master.done",
            threadId,
            turnId,
            outcome: result.outcome,
            phase: result.phase,
          });
          return;
        }
        current = {
          kind: "continue",
          note: "The spec is approved. Propose the plan.",
        };
      }
      this.emit(threadId, {
        type: "master.done",
        threadId,
        turnId,
        outcome: "max_iterations",
        phase: (await this.sessionFor(threadId).state()).phase,
      });
    } catch (error) {
      this.emit(threadId, {
        type: "master.error",
        threadId,
        turnId,
        error: {
          code: "internal",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      });
      this.emit(threadId, {
        type: "master.done",
        threadId,
        turnId,
        outcome: "error",
        phase: store.getThread(threadId)?.phase ?? "intake",
      });
    } finally {
      this.busy.delete(threadId);
      this.turns.delete(threadId);
    }
  }

  /**
   * Put the user's half of the exchange in the visible transcript.
   *
   * The model conversation already has it (the session appends it to
   * `master_messages`), but the Chat timeline reads `messages`, and a thread
   * whose questions and approvals left no trace there would be unreadable
   * after a reload.
   */
  private async recordUserSide(threadId: string, input: MasterInput): Promise<void> {
    const { store } = this.options;
    if (input.kind === "user_message") {
      store.addMessage({ threadId, role: "user", content: input.text });
      return;
    }
    if (input.kind === "answers") {
      const state = await this.sessionFor(threadId).state();
      const questions = state.pending?.kind === "ask_user" ? state.pending.questions : [];
      const lines = input.answers.map((answer) => {
        const question = questions.find((entry) => entry.id === answer.id);
        return question ? `${question.text}\n→ ${answer.answer}` : `${answer.id}: ${answer.answer}`;
      });
      store.addMessage({ threadId, role: "user", content: lines.join("\n\n") });
      return;
    }
    if (input.kind === "approval") {
      const state = await this.sessionFor(threadId).state();
      const summary =
        state.pending?.kind === "request_approval" ? state.pending.request.summary : "the request";
      store.addMessage({
        threadId,
        role: "system",
        content: `${input.decision === "approved" ? "Approved" : "Rejected"}: ${summary}${
          input.note ? `\n${input.note}` : ""
        }`,
      });
    }
  }

  /** Stream one `send()`, narrating it onto the log as it goes. */
  private async runTurn(threadId: string, input: MasterInput, turnId: string): Promise<TurnResult> {
    const { store } = this.options;
    const session = this.sessionFor(threadId);

    let buffer = "";
    let text = "";
    const toolCalls: MessageToolCall[] = [];
    const attachments: MessageAttachment[] = [];
    let usage: MasterUsageTotals | null = null;
    let outcome: MasterTurnOutcome = "error";
    let phase = store.getThread(threadId)?.phase ?? "intake";

    const flush = () => {
      if (!buffer) return;
      this.emit(threadId, { type: "master.text_delta", threadId, turnId, text: buffer });
      buffer = "";
    };

    for await (const event of session.send(input)) {
      if (event.type !== "text_delta") flush();
      this.narrate(threadId, turnId, event);

      switch (event.type) {
        case "text_delta":
          text += event.text;
          buffer += event.text;
          if (buffer.length >= TEXT_FLUSH_CHARS) flush();
          break;

        case "tool_call":
          toolCalls.push({ callId: event.callId, name: event.name, input: event.input });
          break;

        case "tool_result": {
          const call = toolCalls.find((entry) => entry.callId === event.callId);
          if (call) {
            call.ok = event.ok;
            call.output = normaliseToolOutput(event.output);
          }
          break;
        }

        case "plan_proposed": {
          const plan = store.getPlan(threadId);
          if (plan) {
            attachments.push({
              kind: "plan_preview",
              planId: plan.id,
              title: `Plan v${plan.version} — ${event.plan.tasks.length} tasks`,
              taskTitles: event.plan.tasks.map((task) => task.title),
            });
          }
          break;
        }

        case "usage":
          usage = event.thread;
          break;

        case "done":
          outcome = event.outcome;
          phase = event.phase;
          break;

        default:
          break;
      }
    }

    flush();

    if (text.trim() || toolCalls.length > 0) {
      store.addMessage({
        threadId,
        role: "master",
        content: text.trim(),
        toolCalls,
        attachments,
      });
    }

    if (usage) store.updateThread(threadId, { costUSD: usage.costUSD });

    return { outcome, phase };
  }

  /**
   * `MasterEvent` → thread log.
   *
   * Only the events with no entity behind them are narrated. `spec_updated`,
   * `plan_proposed`, `approval_requested` and `phase_changed` already reached
   * the store through `ServerMasterHost`, which appended `spec.upserted`,
   * `plan.upserted`, `approval.requested` and `thread.phase_changed` — copying
   * them again would make the UI apply the same change twice.
   */
  private narrate(threadId: string, turnId: string, event: MasterEvent): void {
    switch (event.type) {
      case "tool_call":
        this.emit(threadId, {
          type: "master.tool_call",
          threadId,
          turnId,
          callId: event.callId,
          name: event.name,
          input: event.input,
        });
        break;

      case "tool_result":
        this.emit(threadId, {
          type: "master.tool_result",
          threadId,
          turnId,
          callId: event.callId,
          name: event.name,
          ok: event.ok,
          output: normaliseToolOutput(event.output),
        });
        break;

      case "question":
        this.emit(threadId, {
          type: "master.question",
          threadId,
          turnId,
          callId: event.callId,
          questions: event.questions.map((question) => ({
            id: question.id,
            text: question.text,
            options: [...(question.options ?? [])],
            allowFreeText: question.allowFreeText !== false,
          })),
        });
        break;

      case "usage":
        this.emit(threadId, {
          type: "master.usage",
          threadId,
          turnId,
          turn: event.turn,
          thread: event.thread,
          budgetUSD: event.budgetUSD,
        });
        break;

      case "error":
        this.emit(threadId, { type: "master.error", threadId, turnId, error: event.error });
        break;

      default:
        break;
    }
  }

  /** Append one `master.*` event; the WebSocket fan-out does the rest. */
  private emit(threadId: string, payload: { type: string } & Record<string, unknown>): void {
    const thread = this.options.store.getThread(threadId);
    if (!thread) return;
    this.options.store.events.append({
      workspaceId: thread.workspaceId,
      threadId,
      type: payload.type as Parameters<NexestraStore["events"]["append"]>[0]["type"],
      payload,
    });
  }
}

function toPendingResponse(state: MasterThreadState): MasterPending | null {
  const pending = state.pending;
  if (!pending) return null;
  if (pending.kind === "ask_user") {
    return {
      kind: "ask_user",
      callId: pending.callId,
      questions: pending.questions.map((question) => ({
        id: question.id,
        text: question.text,
        options: [...(question.options ?? [])],
        allowFreeText: question.allowFreeText !== false,
      })),
    };
  }
  return {
    kind: "request_approval",
    callId: pending.callId,
    approvalId: pending.approvalId,
    summary: pending.request.summary,
  };
}

/**
 * Tool results arrive as API content blocks. The log and the message row want
 * something a human can read, so the text blocks are joined and anything else
 * is left as-is.
 */
function normaliseToolOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  const texts = output
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "text"
        ? (block as { text?: string }).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string");
  return texts.length > 0 ? texts.join("\n") : output;
}
