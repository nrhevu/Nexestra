/**
 * `ServerMasterHost` — `MasterHost` implemented against the store.
 *
 * The Master decides *what* should happen; this file is the only place those
 * decisions become rows. Everything it writes goes through a `NexestraStore`
 * command, so each write appends its event in the same transaction and the
 * WebSocket pushes it to the UI without any extra plumbing.
 *
 * Split of duties:
 *
 * - read tools → `createFsWorkspaceReader` on the workspace's repository root;
 * - `record_memory`, `request_approval`, and the three notifications
 *   (`onSpecUpdated`, `onPlanProposed`, `onPhaseChanged`) → store commands;
 * - the execution-phase tools → an injected `ExecutionHost` (see
 *   `execution-host.ts`), which is `NotYetAvailableExecutionHost` until the
 *   orchestrator lands.
 *
 * The one piece of real translation happens in `onPlanProposed`: the model
 * authors its own task ids (`t1`, `scaffold`, …) and the store needs stable
 * `Task.id`s. Rather than keep a side table, the id is *derived* from the pair
 * (`threadId`, plan task id), which makes a replan an idempotent upsert and
 * lets `dispatch_task("t1")` be resolved without any bookkeeping.
 */
import type { HarnessConfig, Memory, Spec, ThreadPhase } from "@nexestra/core";
import type {
  ApprovalRequestResult,
  ControlRunInput,
  DispatchTaskInput,
  DispatchTaskResult,
  MarkCriterionInput,
  MarkCriterionResult,
  MasterHost,
  MasterPlanProposal,
  ReadArtifactInput,
  ReadArtifactResult,
  ReadRunEventsInput,
  ReadRunEventsResult,
  ReadWorkspaceInput,
  ReadWorkspaceResult,
  RecordMemoryInput,
  RequestApprovalInput,
  RunVerificationInput,
  RunVerificationResult,
  SearchCodeInput,
  SearchCodeResult,
  SummarizeInput,
  TaskDispatchDefaults,
} from "@nexestra/master";
import { createFsWorkspaceReader } from "@nexestra/master";
import type { NexestraStore } from "@nexestra/storage";
import type { ExecutionContext, ExecutionHost } from "./execution-host.js";

export interface ServerMasterHostOptions {
  readonly store: NexestraStore;
  readonly workspaceId: string;
  readonly threadId: string;
  /** Absolute repository root; the read tools are confined to it. */
  readonly workspacePath: string;
  readonly execution: ExecutionHost;
}

/**
 * Store id for a model-authored plan task.
 *
 * Deterministic on purpose: a `replan` that keeps `t1` updates the same row,
 * the board keeps its card, and nothing has to remember a mapping across a
 * server restart.
 */
export function taskIdFor(threadId: string, planTaskId: string): string {
  const slug = `${threadId}__${planTaskId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 96);
  return `task_${slug}`;
}

export function createServerMasterHost(options: ServerMasterHostOptions): MasterHost {
  const { store, workspaceId, threadId, workspacePath, execution } = options;
  const reader = createFsWorkspaceReader({ root: workspacePath });
  const context: ExecutionContext = { workspaceId, threadId, workspacePath };

  /**
   * Resolve whatever id the model used onto a persisted task.
   *
   * It accepts a real `Task.id` too, because the user can rename or add tasks
   * from the board and the Master may well have read those back.
   */
  function resolveTaskId(candidate: string): string {
    if (store.getTask(candidate)) return candidate;
    const derived = taskIdFor(threadId, candidate);
    if (store.getTask(derived)) return derived;
    throw new Error(
      `no task \`${candidate}\` in this thread; ` +
        `known tasks: ${store
          .listTasks(threadId)
          .map((task) => task.id)
          .join(", ")}`,
    );
  }

  return {
    /* ------------------------------------------------------------- read side */

    readWorkspace(input: ReadWorkspaceInput): Promise<ReadWorkspaceResult> {
      return reader.readWorkspace(input);
    },

    searchCode(input: SearchCodeInput): Promise<SearchCodeResult> {
      return reader.searchCode(input);
    },

    /* ------------------------------------------------------------ write side */

    async recordMemory(input: RecordMemoryInput): Promise<Memory> {
      const memory = store.upsertMemory({
        workspaceId,
        threadId,
        type: input.type,
        title: input.title,
        content: input.content,
        authoredBy: "master",
        ...(input.tags ? { tags: input.tags } : {}),
      });

      // Links to nodes that do not exist yet are dropped rather than fatal: the
      // Master often references a memory it is about to write in the same turn.
      let current = memory;
      for (const link of input.links ?? []) {
        if (!store.getMemory(link.targetId)) continue;
        current = store.linkMemories(memory.id, {
          targetId: link.targetId,
          type: link.type,
          ...(link.note ? { note: link.note } : {}),
        });
      }
      return current;
    },

    async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequestResult> {
      const approval = store.createApproval({
        threadId,
        kind: input.kind,
        title: input.summary,
        description: input.payload?.detail ?? "",
        risk: input.payload?.risk ?? (input.kind === "spec" ? "low" : "high"),
        ...(input.payload?.taskId ? { taskId: resolveTaskIdQuietly(input.payload.taskId) } : {}),
        ...(input.payload?.runId ? { runId: input.payload.runId } : {}),
      });
      // Always pending: the decision is the user's, and it arrives back through
      // `POST /api/approvals/:id/resolve`, which resumes the suspended turn.
      return { approvalId: approval.id, status: "pending" };
    },

    /* --------------------------------------------------------- notifications */

    async onSpecUpdated(spec: Spec): Promise<void> {
      store.upsertSpec(threadId, {
        version: spec.version,
        goal: spec.goal || "(being drafted)",
        scope: spec.scope,
        constraints: spec.constraints,
        expectedOutcome: spec.expectedOutcome,
        acceptanceCriteria: spec.acceptanceCriteria,
        openQuestions: spec.openQuestions,
        decisions: spec.decisions,
        frozen: spec.frozen,
      });
    },

    async onPlanProposed(plan: MasterPlanProposal): Promise<void> {
      persistPlan(store, threadId, plan);
    },

    async onPhaseChanged(_from: ThreadPhase, to: ThreadPhase): Promise<void> {
      store.updateThread(threadId, { phase: to });
    },

    async dispatchDefaults(): Promise<TaskDispatchDefaults> {
      if (execution.dispatchDefaults) return execution.dispatchDefaults(context);
      const settings = store.getSettings();
      const workspace = store.getWorkspace(workspaceId);
      // Empty is `HARNESS_DEFAULT_MODEL` — omit the key rather than show the
      // model an empty string, which it would faithfully put on every task.
      const model = workspace?.settings.defaultModel || settings.defaultModel;
      return {
        harness: workspace?.settings.defaultHarness ?? settings.defaultHarness,
        ...(model ? { model } : {}),
        reasoning: "medium",
        sandbox: workspace?.settings.defaultSandbox ?? settings.defaultSandbox,
      };
    },

    /* ------------------------------------------------------------- execution */

    // `async` so a bad task id comes back as a rejected promise, which the
    // session renders as a recoverable tool error rather than a thrown call.
    async dispatchTask(input: DispatchTaskInput): Promise<DispatchTaskResult> {
      return execution.dispatchTask({ ...input, taskId: resolveTaskId(input.taskId) }, context);
    },

    readRunEvents(input: ReadRunEventsInput): Promise<ReadRunEventsResult> {
      return execution.readRunEvents(input, context);
    },

    readArtifact(input: ReadArtifactInput): Promise<ReadArtifactResult> {
      return execution.readArtifact(input, context);
    },

    controlRun(input: ControlRunInput) {
      return execution.controlRun(input, context);
    },

    async runVerification(input: RunVerificationInput): Promise<RunVerificationResult> {
      return execution.runVerification({ ...input, taskId: resolveTaskId(input.taskId) }, context);
    },

    markCriterion(input: MarkCriterionInput): Promise<MarkCriterionResult> {
      return execution.markCriterion(input, context);
    },

    async summarize(input: SummarizeInput): Promise<{ ok: boolean }> {
      store.updateThread(threadId, { summary: input.summary });
      for (const lesson of input.lessons ?? []) {
        store.upsertMemory({
          workspaceId,
          threadId,
          type: "lesson",
          title: lesson.slice(0, 80),
          content: lesson,
          authoredBy: "master",
        });
      }
      return { ok: true };
    },
  };

  /** `payload.taskId` is a hint, not a command: an unknown id is just dropped. */
  function resolveTaskIdQuietly(candidate: string): string | undefined {
    try {
      return resolveTaskId(candidate);
    } catch {
      return undefined;
    }
  }
}

/**
 * Write a proposal to the store: one plan row, one task row per plan task.
 *
 * Task ids are derived, so this is an upsert: tasks the Master kept are
 * updated in place (status and cost preserved), tasks it dropped are deleted,
 * new ones are created. The plan row is written first, with the task ids and
 * edges already computed — possible precisely because the ids are derived.
 */
export function persistPlan(
  store: NexestraStore,
  threadId: string,
  proposal: MasterPlanProposal,
): void {
  const spec = store.getSpec(threadId);
  if (!spec) throw new Error("cannot persist a plan before the thread has a spec");

  const ids = new Map(proposal.tasks.map((task) => [task.id, taskIdFor(threadId, task.id)]));
  const map = (planTaskId: string) => ids.get(planTaskId) ?? taskIdFor(threadId, planTaskId);

  const plan = store.upsertPlan(threadId, {
    specId: spec.id,
    summary: proposal.summary,
    taskIds: proposal.tasks.map((task) => map(task.id)),
    edges: proposal.edges.map((edge) => ({ from: map(edge.from), to: map(edge.to) })),
  });

  const wanted = new Set(ids.values());
  proposal.tasks.forEach((task, order) => {
    const id = map(task.id);
    const harnessConfig: HarnessConfig = task.harnessConfig;
    const shared = {
      title: task.title,
      description: task.description,
      dependsOn: task.dependsOn.map(map),
      assignedHarness: task.harness,
      harnessConfig,
      acceptanceCriteriaIds: [...task.acceptanceCriteriaIds],
      order,
    };

    // A replan must not reset a task the orchestrator already moved, so
    // `status`, `attempts` and `costUSD` are left to whatever the row holds.
    if (store.getTask(id)) store.updateTask(id, shared);
    else store.createTask({ id, threadId, planId: plan.id, status: "todo", ...shared });
  });

  for (const existing of store.listTasks(threadId)) {
    if (existing.planId === plan.id && !wanted.has(existing.id)) store.deleteTask(existing.id);
  }
}
