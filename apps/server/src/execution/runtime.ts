/**
 * `ExecutionRuntime` — the orchestrator, wired into the server (M6).
 *
 * `docs/orchestrator.md` §7 describes four jobs; this file is all four:
 *
 * 1. **One orchestrator per process**, built from the store, the harness
 *    registry and the settings (concurrency, attempts, budget, prices).
 * 2. **The `MasterBridge`.** `notify()` turns the loop's events into
 *    `orchestrator.*` store events — which the existing `/ws` fan-out carries
 *    to the UI for free — and into phase triggers on the Master's session.
 *    `requestReplan()` sends the Master a `continue` turn carrying the failure
 *    evidence, so the model calls its own `replan` tool.
 * 3. **The `ExecutionHost`.** `orchestrator.host` implements the six execution
 *    callbacks; this adds the `ExecutionContext` the server's seam passes and
 *    the dispatch defaults the planning prompt shows.
 * 4. **Lifecycle.** `recoverAll()` before traffic, `dispose()` on a signal.
 *
 * The orchestrator never writes `Thread.phase` itself (that machine belongs to
 * the Master), which is exactly why the translation lives here.
 */

import path from "node:path";
import type {
  Approval,
  ExecutionStatus,
  HarnessId,
  OrchestratorProgress,
  ThreadOutcome,
} from "@nexestra/core";
import { DEFAULT_PRICE_TABLE, TaskStatusSchema } from "@nexestra/core";
import type { TaskDispatchDefaults } from "@nexestra/master";
import type {
  MasterBridge,
  Orchestrator,
  OrchestratorEvent,
  OrchestratorStatus,
  ReplanEvidence,
} from "@nexestra/orchestrator";
import { branchNameFor, createOrchestrator, mergeTaskBranch } from "@nexestra/orchestrator";
import { type NexestraStore, nexestraHome } from "@nexestra/storage";
import type { ExecutionContext, ExecutionHost } from "../master/execution-host.js";
import type { MasterRunner } from "../master/runner.js";
import {
  createHarnessRegistry,
  type HarnessRegistry,
  type HarnessRegistryOptions,
} from "./harnesses.js";
import { affectsStatus, toProgress } from "./progress.js";

export interface ExecutionRuntimeOptions {
  readonly store: NexestraStore;
  /** Worktrees live at `<root>/<threadId>/<taskId>`. Default `$NEXESTRA_HOME/worktrees`. */
  readonly worktreeRoot?: string;
  /** Replace or force the harness registry — what the tests inject. */
  readonly harnesses?: HarnessRegistry | HarnessRegistryOptions;
  /** Register only these harness ids. Defaults to `NEXESTRA_HARNESSES`. */
  readonly only?: readonly HarnessId[];
  /** Ask the Master to summarise once a thread reaches `done`. Default on. */
  readonly autoSummarize?: boolean;
}

export class ExecutionRuntime implements MasterBridge {
  readonly registry: HarnessRegistry;
  readonly orchestrator: Orchestrator;
  readonly host: ExecutionHost;

  private master: MasterRunner | null = null;
  private readonly store: NexestraStore;
  private readonly autoSummarize: boolean;
  private readonly unsubscribe: () => void;
  /** Merges are serialised: two branches landing on one base is the conflict. */
  private merges: Promise<unknown> = Promise.resolve();

  constructor(options: ExecutionRuntimeOptions) {
    const { store } = options;
    this.store = store;
    this.autoSummarize = options.autoSummarize !== false;

    const settings = store.getSettings();
    this.registry = isRegistry(options.harnesses)
      ? options.harnesses
      : createHarnessRegistry({
          ...(options.only ? { only: options.only } : {}),
          ...(options.harnesses ?? {}),
        });

    this.orchestrator = createOrchestrator({
      store,
      adapters: this.registry.adapters,
      master: this,
      config: {
        worktreeRoot: options.worktreeRoot ?? path.join(nexestraHome(), "worktrees"),
        concurrency: settings.concurrency,
        maxAttempts: settings.maxAttempts,
        autoMerge: settings.autoMerge,
        budgetUSD: settings.budgetUSD,
        priceTable: DEFAULT_PRICE_TABLE,
        // Most runs leave the model unset so the harness picks; price them
        // against whatever `discover()` said that harness defaults to.
        defaultModelFor: (harness) => this.registry.defaultModel(harness),
        removeMergedWorktrees: !settings.keepWorktrees,
        logger: {
          debug() {},
          warn(message, detail) {
            process.stderr.write(`orchestrator: ${message} ${format(detail)}\n`);
          },
          error(message, detail) {
            process.stderr.write(`orchestrator: ${message} ${format(detail)}\n`);
          },
        },
      },
    });

    this.host = this.createExecutionHost();

    // The loop raises a `merge` approval and stops there; somebody has to
    // actually land the branch once a human says yes. That somebody is the
    // process that owns the checkout, which is this one.
    this.unsubscribe = store.events.subscribeAll((event) => {
      if (event.type !== "approval.resolved") return;
      const approval = event.payload as Approval;
      if (approval.kind !== "merge") return;
      this.merges = this.merges.catch(() => undefined).then(() => this.landApprovedMerge(approval));
    });
  }

  /** True when nothing can actually be run (no adapter is registered). */
  get available(): boolean {
    return Object.values(this.registry.adapters).some((adapter) => adapter !== undefined);
  }

  /** The runner is built after this object, because it needs `host`. */
  attachMaster(master: MasterRunner): void {
    this.master = master;
  }

  /* ------------------------------------------------------------- control API */

  /**
   * Begin executing a thread.
   *
   * The user pressing `[Start execution]` is also the moment the plan is
   * accepted, so the phase trigger happens here rather than in a second
   * gesture: `planning → executing`, then the loop starts scheduling.
   */
  async start(threadId: string): Promise<ExecutionStatus> {
    await this.acceptPlan(threadId);
    return this.wire(await this.orchestrator.start(threadId));
  }

  async pause(threadId: string): Promise<ExecutionStatus> {
    return this.wire(await this.orchestrator.pause(threadId));
  }

  async resume(threadId: string): Promise<ExecutionStatus> {
    return this.wire(await this.orchestrator.resume(threadId));
  }

  async cancel(threadId: string): Promise<ExecutionStatus> {
    return this.wire(await this.orchestrator.cancel(threadId));
  }

  status(threadId: string): ExecutionStatus {
    return this.wire(this.orchestrator.status(threadId));
  }

  /**
   * Answer a `permission_request` a live run raised.
   *
   * The orchestrator's `controlRun` covers pause / resume / cancel / steer;
   * `answer_permission` is addressed to the adapter that owns the process
   * (only OpenCode raises them today), so it goes straight there.
   */
  async answerPermission(
    runId: string,
    input: { requestId: string; approved: boolean; note?: string },
  ): Promise<{ ok: boolean; note?: string }> {
    const run = this.store.getRun(runId);
    if (!run) return { ok: false, note: `unknown run ${runId}` };
    const adapter = this.registry.adapters[run.harness];
    if (!adapter) return { ok: false, note: `no adapter registered for "${run.harness}"` };
    try {
      await adapter.control(runId, {
        action: "answer_permission",
        requestId: input.requestId,
        approved: input.approved,
        ...(input.note ? { note: input.note } : {}),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, note: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Resolve once the thread has nothing left to do. Used by the tests. */
  drain(threadId: string): Promise<void> {
    return this.orchestrator.drain(threadId);
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Repair whatever a crash left behind, for every thread that still has a
   * `running` run. `recover()` is per thread by design, so the sweep is here.
   */
  async recoverAll(): Promise<string[]> {
    const recovered: string[] = [];
    for (const threadId of this.threadsWithLiveRuns()) {
      try {
        await this.orchestrator.recover(threadId);
        recovered.push(threadId);
      } catch (error) {
        process.stderr.write(`recover(${threadId}) failed: ${String(error)}\n`);
      }
    }
    return recovered;
  }

  /** Cancel every thread, then release the adapters (OpenCode servers die here). */
  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.merges.catch(() => undefined);
    await this.orchestrator.close().catch(() => undefined);
    await this.registry.dispose().catch(() => undefined);
  }

  /**
   * Land a task branch whose `merge` approval was just approved.
   *
   * `mergeTaskBranch` refuses rather than forces: it will not touch a
   * repository that is mid-rebase, dirty, or sitting on another branch. A
   * refusal leaves `mergeState: "pending"` and says why on the log, so the
   * approval the user gave is not silently lost — they can clean the checkout
   * and approve the next one, or merge by hand.
   */
  private async landApprovedMerge(approval: Approval): Promise<void> {
    const at = () => new Date().toISOString();
    const task = approval.taskId ? this.store.getTask(approval.taskId) : null;
    const thread = this.store.getThread(approval.threadId);
    const workspace = thread ? this.store.getWorkspace(thread.workspaceId) : null;
    if (!task || !workspace) return;

    const progress = (level: "info" | "warn" | "error", message: string) => {
      this.append(approval.threadId, "orchestrator.progress", {
        threadId: approval.threadId,
        kind: "merge",
        level,
        message,
        taskId: task.id,
        at: at(),
      });
    };

    if (approval.status !== "approved") {
      progress("warn", `Merge of "${task.title}" was rejected; the branch stays unmerged.`);
      return;
    }

    const branch = task.harnessConfig.branch ?? branchNameFor(approval.threadId, task.id);
    const into = this.orchestrator.config.baseBranch ?? workspace.defaultBranch;

    const result = await mergeTaskBranch({
      repo: workspace.rootPath,
      branch,
      into,
      identity: this.orchestrator.config.commitIdentity,
      message: `Merge ${branch} (${task.title})`,
    }).catch((error) => ({
      outcome: "unavailable" as const,
      detail: error instanceof Error ? error.message : String(error),
    }));

    if (result.outcome === "merged" || result.outcome === "up_to_date") {
      this.store.updateTask(task.id, { mergeState: "merged" });
      progress(
        "info",
        `Merged ${branch} into ${into}${result.outcome === "up_to_date" ? " (already up to date)" : "."}`,
      );
      return;
    }

    if (result.outcome === "conflict") {
      this.store.updateTask(task.id, { mergeState: "conflict" });
      progress(
        "error",
        `Merge of ${branch} conflicted and was aborted${result.detail ? `: ${result.detail}` : "."}`,
      );
      return;
    }

    progress(
      "warn",
      `Could not merge ${branch} into ${into}${result.detail ? `: ${result.detail}` : "."} ` +
        "The branch is still there; land it by hand once the checkout is clean.",
    );
  }

  /* ----------------------------------------------------------- MasterBridge */

  async notify(event: OrchestratorEvent): Promise<void> {
    const at = new Date().toISOString();
    this.append(event.threadId, "orchestrator.progress", toProgress(event, at));
    if (affectsStatus(event)) this.publishStatus(event.threadId);

    if (event.type === "thread_started") {
      await this.acceptPlan(event.threadId);
      return;
    }
    if (event.type === "thread_idle") {
      await this.settle(event.threadId, event.outcome);
    }
  }

  /**
   * Ask the Master to replan a task that ran out of attempts.
   *
   * Only when the Master actually owns this thread. A `continue` turn on a
   * thread the Master has never seen starts its session at `intake` with an
   * empty draft, and the first thing the model does there is `update_spec` —
   * which republishes the draft over whatever spec the thread had. A thread
   * assembled through the REST API (a script, a test fixture, this file's own
   * demo) would lose its acceptance criteria to a failed run. So a thread with
   * no `master_state` gets an error line on the log instead, which says
   * plainly that nothing can replan it.
   */
  async requestReplan(taskId: string, reason: string, evidence: ReplanEvidence): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || !this.master) return;

    if (!this.store.getMasterState(task.threadId)) {
      this.append(task.threadId, "orchestrator.progress", {
        threadId: task.threadId,
        kind: "replan_requested",
        level: "error",
        message:
          `Task "${task.title}" failed after ${evidence.attempts} attempts (${reason}), and ` +
          "the Master has no session on this thread, so there is nobody to replan it. " +
          "Fix the task by hand, or start the thread from the Chat surface.",
        taskId,
        at: new Date().toISOString(),
        detail: evidence,
      });
      return;
    }

    this.master.send(task.threadId, {
      kind: "continue",
      note: renderReplanRequest(task.title, taskId, reason, evidence),
    });
  }

  /* --------------------------------------------------------------- internals */

  private createExecutionHost(): ExecutionHost {
    const host = this.orchestrator.host;
    return {
      dispatchTask: (input) => host.dispatchTask(input),
      readRunEvents: (input) => host.readRunEvents(input),
      readArtifact: (input) => host.readArtifact(input),
      controlRun: (input) => host.controlRun(input),
      runVerification: (input) => host.runVerification(input),
      markCriterion: (input) => host.markCriterion(input),
      dispatchDefaults: (context: ExecutionContext): TaskDispatchDefaults => {
        const settings = this.store.getSettings();
        const workspace = this.store.getWorkspace(context.workspaceId);
        const preferred = workspace?.settings.defaultHarness ?? settings.defaultHarness;
        const harness = this.registry.adapters[preferred]
          ? preferred
          : ((Object.keys(this.registry.adapters)[0] as HarnessId | undefined) ?? preferred);
        // An empty `defaultModel` is `HARNESS_DEFAULT_MODEL`: omit the key so
        // nothing downstream writes `model: ""` onto a task and the adapter
        // leaves `-m` off the command line.
        const model = workspace?.settings.defaultModel || settings.defaultModel;
        return {
          harness,
          ...(model ? { model } : {}),
          reasoning: "medium",
          sandbox: workspace?.settings.defaultSandbox ?? settings.defaultSandbox,
        };
      },
    };
  }

  /** `OrchestratorStatus` → the wire shape, with the loop's availability. */
  private wire(status: OrchestratorStatus): ExecutionStatus {
    const tasks: Record<string, number> = {};
    for (const key of TaskStatusSchema.options) tasks[key] = status.tasks[key] ?? 0;
    return {
      threadId: status.threadId,
      workspaceId: status.workspaceId,
      state: status.state,
      tasks: tasks as ExecutionStatus["tasks"],
      totalTasks: status.totalTasks,
      activeRuns: status.activeRuns.map((run) => ({ ...run })),
      pendingApprovals: status.pendingApprovals,
      costUSD: status.costUSD,
      budgetUSD: status.budgetUSD,
      budgetRatio: status.budgetRatio,
      ...(status.lastOutcome ? { lastOutcome: status.lastOutcome } : {}),
      available: this.available,
    };
  }

  private publishStatus(threadId: string): void {
    try {
      this.append(threadId, "orchestrator.status_changed", this.status(threadId));
    } catch {
      // A thread that vanished mid-flight is not worth an event.
    }
  }

  private append(
    threadId: string,
    type: "orchestrator.progress" | "orchestrator.status_changed",
    payload: OrchestratorProgress | ExecutionStatus,
  ): void {
    try {
      const thread = this.store.getThread(threadId);
      if (!thread) return;
      this.store.events.append({
        workspaceId: thread.workspaceId,
        threadId,
        type,
        payload,
      });
    } catch {
      // Narration is never worth a crash — the store can be closed under a
      // task that is still finishing when the process shuts down.
    }
  }

  /** `planning → executing`, exactly once, and never against a finished thread. */
  private async acceptPlan(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread || !this.master) return;
    if (thread.phase !== "planning") return;
    await this.master.applyTrigger(threadId, { type: "plan_accepted" });
  }

  /**
   * What the end of a run of the loop means for the Master's phase machine.
   *
   * `completed` is two steps, not one: every task done moves the thread into
   * `verifying`, and only a spec whose criteria all carry evidence moves it on
   * to `done`. Anything short of that leaves the thread in `verifying` with a
   * nudge, so the Master runs the criteria that are still missing.
   */
  private async settle(threadId: string, outcome: ThreadOutcome): Promise<void> {
    const master = this.master;
    if (!master) return;
    if (outcome === "paused" || outcome === "cancelled") return;

    // Same hazard `requestReplan` guards against: a `continue` turn on a thread
    // the Master has never seen starts its session at `intake` with an empty
    // draft, and the first thing the model does there is `update_spec` — which
    // would publish that empty draft over a thread assembled through the REST
    // API. A thread with no session gets a log line instead of a turn.
    if (!this.store.getMasterState(threadId)) {
      this.append(threadId, "orchestrator.progress", {
        threadId,
        kind: "thread_idle",
        level: outcome === "completed" ? "info" : "warn",
        message:
          `Execution finished (${outcome}), and no Master session owns this thread, ` +
          "so nothing will summarise or replan it.",
        at: new Date().toISOString(),
      });
      return;
    }

    if (outcome !== "completed") {
      await master.applyTrigger(threadId, {
        type: "blocked",
        reason:
          outcome === "budget_exceeded"
            ? "the thread ran out of budget"
            : `execution stopped: ${outcome}`,
      });
      return;
    }

    await master.applyTrigger(threadId, { type: "all_tasks_done" });

    const spec = this.store.getSpec(threadId);
    const criteria = spec?.acceptanceCriteria ?? [];
    const unverified = criteria.filter((criterion) => !criterion.satisfied);

    if (criteria.length > 0 && unverified.length === 0) {
      const moved = await master.applyTrigger(threadId, { type: "all_criteria_verified" });
      if (moved?.ok && this.autoSummarize) {
        master.send(threadId, {
          kind: "continue",
          note:
            "Every task is done and every acceptance criterion has evidence. " +
            "Summarise what was delivered and record the lessons worth keeping.",
        });
      }
      return;
    }

    master.send(threadId, {
      kind: "continue",
      note:
        `Every task finished, but ${unverified.length || criteria.length} acceptance ` +
        "criterion/criteria still lack evidence. Run the verification for them and mark them.",
    });
  }

  private threadsWithLiveRuns(): string[] {
    const ids = new Set<string>();
    for (const thread of this.store.listThreads()) {
      const runs = this.store.listRuns(thread.id);
      if (runs.some((run) => run.status === "running" || run.status === "pending")) {
        ids.add(thread.id);
      }
    }
    return [...ids];
  }
}

/* ------------------------------------------------------------------ helpers */

function isRegistry(value: ExecutionRuntimeOptions["harnesses"]): value is HarnessRegistry {
  return typeof value === "object" && value !== null && "list" in value;
}

function format(detail: unknown): string {
  if (detail === undefined) return "";
  return detail instanceof Error ? detail.message : JSON.stringify(detail);
}

/**
 * What the Master is told when a task runs out of attempts.
 *
 * Everything `ReplanEvidence` carries is spelled out, because the model's
 * `replan` tool has to decide whether to split the task, change the harness or
 * change the model — and it can only read what is in the turn.
 */
function renderReplanRequest(
  title: string,
  taskId: string,
  reason: string,
  evidence: ReplanEvidence,
): string {
  const lines = [
    `Task \`${taskId}\` ("${title}") failed after ${evidence.attempts} of ` +
      `${evidence.maxAttempts} attempts: ${reason}`,
    "",
    "Call `replan` with a fix — split the task, change the harness, change the model, " +
      "or narrow the scope. If nothing can be salvaged, say so and stop.",
    "",
  ];
  if (evidence.lastError) lines.push(`Last error: ${evidence.lastError}`, "");
  if (evidence.reviewFindings?.length) {
    lines.push("Blocking review findings:");
    for (const finding of evidence.reviewFindings) {
      lines.push(`- [${finding.severity}] ${finding.title}: ${finding.body}`);
    }
    lines.push("");
  }
  if (evidence.verification?.length) {
    lines.push("Verification outcomes:");
    for (const outcome of evidence.verification) {
      lines.push(
        `- ${outcome.criterionId}: ${outcome.passed ? "passed" : "failed"}` +
          (outcome.exitCode === undefined ? "" : ` (exit ${outcome.exitCode})`),
      );
    }
    lines.push("");
  }
  if (evidence.runIds.length > 0) {
    lines.push(`Runs: ${evidence.runIds.join(", ")}`);
  }
  if (evidence.artifactIds.length > 0) {
    lines.push(`Artifacts (read them with \`read_artifact\`): ${evidence.artifactIds.join(", ")}`);
  }
  return lines.join("\n");
}
