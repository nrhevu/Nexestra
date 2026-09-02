/**
 * The per-thread scheduler and task pipeline (PLAN.md §6).
 *
 * One `ThreadEngine` owns one thread: it picks ready tasks off the DAG,
 * respects the concurrency limit, and drives each task through
 * `execute → review → verify → merge`, retrying and eventually asking the
 * Master to replan. It writes every state change through `NexestraStore`, so
 * the UI sees the loop over the existing `/ws` fan-out and nothing else has to
 * be wired up.
 *
 * The engine deliberately does **not** write `Thread.phase`: the phase machine
 * belongs to the Master (`docs/master.md` §3). It reports through
 * `MasterBridge.notify()` and lets the server apply the trigger.
 */
import type {
  AcceptanceCriterion,
  HarnessAdapter,
  HarnessEvent,
  HarnessId,
  Run,
  RunKind,
  Spec,
  Task,
  TaskStatus,
  Workspace,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import {
  AbortedError,
  createApproval,
  evaluateGate,
  requestApproval,
  waitForApproval,
} from "./approvals.js";
import { writeArtifact } from "./artifacts.js";
import { budgetState } from "./budget.js";
import { BUDGET_WARNING_RATIO, type ResolvedConfig } from "./config.js";
import {
  buildExecuteInstructions,
  buildReviewInstructions,
  buildRunSpec,
  criteriaForTask,
  type FailureContext,
} from "./instructions.js";
import { blockingFindings } from "./review.js";
import { executeRun, type RunOutcome } from "./runner.js";
import type {
  ActiveRunSummary,
  DispatchHarnessConfig,
  MasterBridge,
  OrchestratorEvent,
  OrchestratorStatus,
  RecoverReport,
  ReviewFinding,
  RunVerificationResult,
  ThreadOutcome,
  ThreadRunState,
  VerificationOutcome,
} from "./types.js";
import { renderEvidence, runVerificationCommand, summariseEvidence } from "./verification.js";
import {
  commitWorktree,
  ensureTaskWorktree,
  mergeTaskBranch,
  pruneStaleWorktrees,
  worktreePathFor,
} from "./worktree.js";

const TASK_STATUSES: readonly TaskStatus[] = [
  "todo",
  "ready",
  "running",
  "review",
  "verifying",
  "done",
  "failed",
  "blocked",
];

export interface DispatchOptions {
  kind?: RunKind;
  instructions?: string;
  harness?: HarnessId;
  harnessConfig?: DispatchHarnessConfig;
}

export interface EngineDeps {
  store: NexestraStore;
  adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  master: MasterBridge;
  config: ResolvedConfig;
}

interface LiveRun {
  runId: string;
  taskId: string;
  kind: RunKind;
  harness: HarnessId;
  adapter: HarnessAdapter;
  controller: AbortController;
  startedAt: string;
}

/** A task is ready when every dependency is done and it has not started yet. */
export function selectReadyTasks(tasks: readonly Task[]): Task[] {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  return tasks
    .filter(
      (task) =>
        (task.status === "todo" || task.status === "ready") &&
        task.dependsOn.every((dependency) => done.has(dependency)),
    )
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export class ThreadEngine {
  private readonly store: NexestraStore;
  private readonly adapters: Partial<Record<HarnessId, HarnessAdapter>>;
  private readonly master: MasterBridge;
  private readonly config: ResolvedConfig;

  private state: ThreadRunState = "idle";
  private lastOutcome: ThreadOutcome | undefined;
  private controller = new AbortController();
  private readonly pipelines = new Map<string, Promise<void>>();
  private readonly liveRuns = new Map<string, LiveRun>();
  private readonly idleWaiters: Array<() => void> = [];
  private mergeQueue: Promise<unknown> = Promise.resolve();
  private budgetWarned = false;
  private ticking = false;

  constructor(
    readonly threadId: string,
    deps: EngineDeps,
  ) {
    this.store = deps.store;
    this.adapters = deps.adapters;
    this.master = deps.master;
    this.config = deps.config;
  }

  /* ------------------------------------------------------------ lifecycle */

  start(): OrchestratorStatus {
    if (this.state === "cancelled") this.controller = new AbortController();
    this.state = "running";
    this.lastOutcome = undefined;
    void this.notify({ type: "thread_started", threadId: this.threadId });
    this.tick();
    return this.status();
  }

  pause(): OrchestratorStatus {
    if (this.state !== "cancelled") this.state = "paused";
    return this.status();
  }

  resume(): OrchestratorStatus {
    if (this.state === "paused") {
      this.state = "running";
      this.tick();
    }
    return this.status();
  }

  async cancel(): Promise<OrchestratorStatus> {
    this.state = "cancelled";
    const live = [...this.liveRuns.values()];
    this.controller.abort();
    await Promise.all(
      live.map(async (run) => {
        run.controller.abort();
        await run.adapter
          .control(run.runId, { action: "cancel", reason: "thread cancelled" })
          .catch((error: unknown) => {
            this.config.logger.debug(`orchestrator: cancel(${run.runId}) not applied`, error);
          });
      }),
    );
    await this.settle();
    this.lastOutcome = "cancelled";
    return this.status();
  }

  /** Resolve once no pipeline is running. */
  async settle(): Promise<void> {
    while (this.pipelines.size > 0) {
      await Promise.allSettled([...this.pipelines.values()]);
    }
  }

  /** Resolve once the thread has nothing left to do. */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private isIdle(): boolean {
    if (this.pipelines.size > 0) return false;
    if (this.state !== "running") return true;
    return selectReadyTasks(this.store.listTasks(this.threadId)).length === 0;
  }

  /* ------------------------------------------------------------ scheduler */

  tick(): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.schedule();
    } finally {
      this.ticking = false;
    }
  }

  private schedule(): void {
    if (this.state !== "running") {
      this.checkIdle();
      return;
    }

    const tasks = this.store.listTasks(this.threadId);
    const ready = selectReadyTasks(tasks).filter((task) => !this.pipelines.has(task.id));

    for (const task of ready) {
      if (this.pipelines.size >= this.config.concurrency) break;
      this.launch(task.id, {});
    }

    this.checkIdle();
  }

  private checkIdle(): void {
    if (this.pipelines.size > 0) return;
    if (this.state === "running") {
      const tasks = this.store.listTasks(this.threadId);
      if (selectReadyTasks(tasks).length > 0) return;
      this.state = "idle";
      this.lastOutcome = outcomeFor(tasks);
      void this.notify({
        type: "thread_idle",
        threadId: this.threadId,
        outcome: this.lastOutcome,
      });
    }
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const waiter of waiters) waiter();
  }

  private launch(
    taskId: string,
    options: DispatchOptions,
    onRunRecorded?: (run: Run) => void,
  ): void {
    const promise = this.pipeline(taskId, options, onRunRecorded)
      .catch((error: unknown) => {
        if (error instanceof AbortedError) return;
        const message = error instanceof Error ? error.message : String(error);
        this.config.logger.error(`orchestrator: task ${taskId} pipeline crashed`, error);
        void this.notify({ type: "error", threadId: this.threadId, taskId, message });
        this.safeStatus(taskId, "failed");
      })
      .finally(() => {
        this.pipelines.delete(taskId);
        queueMicrotask(() => this.tick());
      });
    this.pipelines.set(taskId, promise);
  }

  /* ------------------------------------------------------------- dispatch */

  /** Start work on one task and resolve as soon as its first run row exists. */
  dispatch(taskId: string, options: DispatchOptions = {}): Promise<Run> {
    const existing = this.pipelines.get(taskId);
    if (existing) {
      const run = this.latestRunFor(taskId);
      if (run) return Promise.resolve(run);
    }

    return new Promise<Run>((resolve, reject) => {
      let settled = false;
      const onRunRecorded = (run: Run) => {
        if (settled) return;
        settled = true;
        resolve(run);
      };
      if (this.state === "idle") this.state = "running";
      this.launch(taskId, options, onRunRecorded);
      // A pipeline that ends without ever recording a run (blocked on an
      // approval, out of attempts) still has to answer the caller.
      void this.pipelines.get(taskId)?.then(() => {
        if (settled) return;
        settled = true;
        const run = this.latestRunFor(taskId);
        if (run) resolve(run);
        else reject(new Error(`task ${taskId} produced no run`));
      });
    });
  }

  private latestRunFor(taskId: string): Run | undefined {
    const runs = this.store.listRuns(this.threadId).filter((run) => run.taskId === taskId);
    return runs.at(-1);
  }

  /* -------------------------------------------------------------- control */

  async controlRun(
    runId: string,
    action: { action: "pause" | "resume" | "cancel" | "steer"; message?: string },
  ): Promise<{ ok: boolean; note?: string }> {
    const live = this.liveRuns.get(runId);
    if (!live) {
      const known = this.store.getRun(runId);
      return {
        ok: false,
        note: known ? `run ${runId} is ${known.status}` : `unknown run ${runId}`,
      };
    }
    try {
      if (action.action === "cancel") {
        live.controller.abort();
        await live.adapter.control(runId, {
          action: "cancel",
          reason: action.message ?? "cancelled",
        });
        return { ok: true };
      }
      if (action.action === "steer") {
        await live.adapter.control(runId, { action: "steer", message: action.message ?? "" });
        return { ok: true };
      }
      await live.adapter.control(runId, { action: action.action });
      return { ok: true };
    } catch (error) {
      return { ok: false, note: error instanceof Error ? error.message : String(error) };
    }
  }

  /* -------------------------------------------------------------- recover */

  async recover(): Promise<RecoverReport> {
    const workspace = this.workspace();
    const runs = this.store.listRuns(this.threadId);
    const interruptedRuns: string[] = [];
    const resetTasks = new Set<string>();

    for (const run of runs) {
      if (run.status !== "running" && run.status !== "pending") continue;
      this.store.recordRun({
        id: run.id,
        threadId: run.threadId,
        taskId: run.taskId,
        kind: run.kind,
        harness: run.harness,
        status: "interrupted",
        endedAt: this.config.now(),
      });
      interruptedRuns.push(run.id);
      resetTasks.add(run.taskId);
    }

    for (const taskId of resetTasks) {
      const task = this.store.getTask(taskId);
      if (!task) continue;
      // The attempt was already counted when the run started, so a recovered
      // task resumes with its budget of attempts correctly spent.
      if (task.status === "done" || task.status === "failed" || task.status === "blocked") continue;
      this.setStatus(task, "ready");
    }

    const tasks = this.store.listTasks(this.threadId);
    const removedWorktrees = await pruneStaleWorktrees({
      repo: workspace.rootPath,
      worktreeRoot: this.config.worktreeRoot,
      threadId: this.threadId,
      keep: new Set(tasks.map((task) => task.id)),
    }).catch((error: unknown) => {
      this.config.logger.warn("orchestrator: could not prune stale worktrees", error);
      return [] as string[];
    });

    return {
      threadId: this.threadId,
      interruptedRuns,
      resetTasks: [...resetTasks],
      removedWorktrees,
    };
  }

  /* --------------------------------------------------------------- status */

  status(): OrchestratorStatus {
    const thread = this.store.getThread(this.threadId);
    const tasks = this.store.listTasks(this.threadId);
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
      TaskStatus,
      number
    >;
    for (const task of tasks) counts[task.status] += 1;

    const budgetUSD = this.config.budgetUSD ?? thread?.budgetUSD ?? 0;
    const costUSD = thread?.costUSD ?? 0;
    const activeRuns: ActiveRunSummary[] = [...this.liveRuns.values()].map((run) => ({
      runId: run.runId,
      taskId: run.taskId,
      kind: run.kind,
      harness: run.harness,
      startedAt: run.startedAt,
    }));

    return {
      threadId: this.threadId,
      workspaceId: thread?.workspaceId ?? "",
      state: this.state,
      tasks: counts,
      totalTasks: tasks.length,
      activeRuns,
      pendingApprovals: this.store.listApprovals({ threadId: this.threadId, status: "pending" })
        .length,
      costUSD,
      budgetUSD,
      budgetRatio: budgetUSD > 0 ? costUSD / budgetUSD : 0,
      ...(this.lastOutcome ? { lastOutcome: this.lastOutcome } : {}),
    };
  }

  /* ------------------------------------------------------------- pipeline */

  private async pipeline(
    taskId: string,
    options: DispatchOptions,
    onRunRecorded?: (run: Run) => void,
  ): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted) return;

    if (options.kind && options.kind !== "execute") {
      await this.runSingle(taskId, options, onRunRecorded);
      return;
    }

    const workspace = this.workspace();
    const failures: FailureContext[] = [];
    let reviewFindings: readonly ReviewFinding[] = [];
    let verification: readonly VerificationOutcome[] = [];
    const runIds: string[] = [];
    const artifactIds: string[] = [];
    let lastError: string | undefined;

    for (;;) {
      if (signal.aborted) return;
      let task = this.requireTask(taskId);
      const limit = Math.min(task.maxAttempts, this.config.maxAttempts);

      if (task.attempts >= limit) {
        this.setStatus(task, "failed");
        await this.replan(task, lastError ?? `no attempt succeeded within ${limit} attempts`, {
          runIds,
          artifactIds,
          lastError,
          reviewFindings,
          verification,
        });
        return;
      }

      if (!this.checkBudget()) {
        this.setStatus(task, "ready");
        return;
      }

      this.setStatus(task, "ready");
      const worktree = await ensureTaskWorktree({
        repo: workspace.rootPath,
        worktreeRoot: this.config.worktreeRoot,
        threadId: this.threadId,
        taskId: task.id,
        baseBranch: this.baseBranch(workspace),
        ...(task.harnessConfig.worktreePath
          ? { overridePath: task.harnessConfig.worktreePath }
          : {}),
        ...(task.harnessConfig.branch ? { overrideBranch: task.harnessConfig.branch } : {}),
      });

      const spec = this.store.getSpec(this.threadId);
      const criteria = criteriaForTask(spec, task);
      const instructions = buildExecuteInstructions({
        task,
        spec,
        criteria,
        failures,
        reviewFindings,
        verification,
        ...(options.instructions ? { extra: options.instructions } : {}),
      });
      const runSpec = buildRunSpec({
        task,
        kind: "execute",
        cwd: worktree.path,
        instructions,
        config: this.config,
        ...(options.harnessConfig ? { overrides: options.harnessConfig } : {}),
      });

      const gate = evaluateGate(runSpec, task.harnessConfig, this.config);
      if (!gate.allowed) {
        const approval = await requestApproval(
          this.store,
          {
            threadId: this.threadId,
            kind: gate.kind ?? "permission",
            title: gate.title ?? "Approval required",
            ...(gate.description ? { description: gate.description } : {}),
            ...(gate.risk ? { risk: gate.risk } : {}),
            taskId: task.id,
          },
          signal,
          (created) =>
            void this.notify({
              type: "approval_requested",
              threadId: this.threadId,
              approval: created,
            }),
        ).catch((error: unknown) => {
          if (error instanceof AbortedError) return undefined;
          throw error;
        });
        if (!approval) return;
        void this.notify({ type: "approval_resolved", threadId: this.threadId, approval });
        if (approval.status !== "approved") {
          this.setStatus(this.requireTask(taskId), "blocked");
          return;
        }
      }

      const harness = this.harnessFor(task, options.harness);
      const attempt = task.attempts + 1;
      task = this.store.updateTask(task.id, { attempts: attempt });
      this.setStatus(task, "running");

      const outcome = await this.execute({
        task,
        kind: "execute",
        adapter: harness.adapter,
        spec: runSpec,
        worktree: worktree.path,
        attempt,
        parent: signal,
        ...(onRunRecorded ? { onRunRecorded } : {}),
      });
      runIds.push(outcome.runId);
      artifactIds.push(...outcome.artifactIds);

      if (outcome.cancelled || signal.aborted) {
        this.setStatus(this.requireTask(taskId), "blocked");
        return;
      }

      if (!outcome.ok) {
        lastError =
          outcome.error?.message ?? `run exited with code ${outcome.exitCode ?? "unknown"}`;
        const retryable = outcome.error?.retryable ?? false;
        failures.push({ attempt, reason: lastError });
        if (!retryable) {
          this.setStatus(this.requireTask(taskId), "failed");
          await this.replan(this.requireTask(taskId), lastError, {
            runIds,
            artifactIds,
            lastError,
            reviewFindings,
            verification,
          });
          return;
        }
        void this.notify({
          type: "run_retrying",
          threadId: this.threadId,
          taskId,
          attempt,
          reason: lastError,
        });
        continue;
      }

      /* ------------------------------------------------------- cross-review */

      reviewFindings = [];
      if (this.config.reviewEnabled) {
        const reviewer = this.reviewerFor(harness.id);
        if (reviewer) {
          this.setStatus(this.requireTask(taskId), "review");
          const reviewSpec = buildRunSpec({
            task,
            kind: "review",
            cwd: worktree.path,
            instructions: buildReviewInstructions({ task, spec, criteria }),
            config: this.config,
          });
          const reviewOutcome = await this.execute({
            task,
            kind: "review",
            adapter: reviewer.adapter,
            spec: reviewSpec,
            worktree: worktree.path,
            attempt,
            parent: signal,
          });
          runIds.push(reviewOutcome.runId);
          artifactIds.push(...reviewOutcome.artifactIds);

          if (reviewOutcome.cancelled || signal.aborted) {
            this.setStatus(this.requireTask(taskId), "blocked");
            return;
          }

          if (reviewOutcome.ok && reviewOutcome.review) {
            const blocking = blockingFindings(reviewOutcome.review.findings);
            void this.notify({
              type: "review_findings",
              threadId: this.threadId,
              taskId,
              runId: reviewOutcome.runId,
              blocking: blocking.length,
              findings: reviewOutcome.review.findings,
            });
            if (blocking.length > 0) {
              reviewFindings = blocking;
              lastError = `review raised ${blocking.length} blocking finding(s)`;
              failures.push({
                attempt,
                reason: lastError,
                detail: blocking
                  .map((finding) => `[${finding.severity}] ${finding.title}`)
                  .join("\n"),
              });
              void this.notify({
                type: "run_retrying",
                threadId: this.threadId,
                taskId,
                attempt,
                reason: lastError,
              });
              continue;
            }
          } else {
            // A reviewer that could not run is a warning, not a task failure —
            // verification is the gate that actually decides.
            this.config.logger.warn(
              `orchestrator: review run ${reviewOutcome.runId} did not produce findings`,
              reviewOutcome.error,
            );
          }
        }
      }

      /* -------------------------------------------------------- verification */

      if (this.config.verifyEnabled) {
        this.setStatus(this.requireTask(taskId), "verifying");
        const result = await this.verify(taskId, undefined, {
          signal,
          waitForManual: true,
          worktree: worktree.path,
        });
        verification = result.outcomes;
        for (const outcome_ of result.outcomes) {
          if (outcome_.evidenceArtifactId) artifactIds.push(outcome_.evidenceArtifactId);
        }
        if (signal.aborted) return;

        const failed = result.outcomes.filter((each) => !each.passed);
        if (failed.length > 0) {
          lastError = `verification failed for ${failed.map((each) => each.criterionId).join(", ")}`;
          failures.push({
            attempt,
            reason: lastError,
            detail: failed.map((each) => each.output ?? "").join("\n\n"),
          });
          void this.notify({
            type: "run_retrying",
            threadId: this.threadId,
            taskId,
            attempt,
            reason: lastError,
          });
          continue;
        }
      }

      /* --------------------------------------------------------- commit / merge */

      await this.finalize(this.requireTask(taskId), worktree.path, worktree.branch, workspace);
      return;
    }
  }

  /** A single `review` or `verify` run requested by the Master. */
  private async runSingle(
    taskId: string,
    options: DispatchOptions,
    onRunRecorded?: (run: Run) => void,
  ): Promise<void> {
    const task = this.requireTask(taskId);
    const workspace = this.workspace();
    const worktree = await ensureTaskWorktree({
      repo: workspace.rootPath,
      worktreeRoot: this.config.worktreeRoot,
      threadId: this.threadId,
      taskId: task.id,
      baseBranch: this.baseBranch(workspace),
    });
    const spec = this.store.getSpec(this.threadId);
    const criteria = criteriaForTask(spec, task);
    const kind = options.kind ?? "review";
    const instructions =
      kind === "review"
        ? buildReviewInstructions({
            task,
            spec,
            criteria,
            ...(options.instructions ? { extra: options.instructions } : {}),
          })
        : buildExecuteInstructions({
            task,
            spec,
            criteria,
            ...(options.instructions ? { extra: options.instructions } : {}),
          });
    const runSpec = buildRunSpec({
      task,
      kind,
      cwd: worktree.path,
      instructions,
      config: this.config,
      ...(options.harnessConfig ? { overrides: options.harnessConfig } : {}),
    });
    const executor = this.harnessFor(task, options.harness);
    const adapter =
      kind === "review"
        ? (this.reviewerFor(executor.id)?.adapter ?? executor.adapter)
        : executor.adapter;

    await this.execute({
      task,
      kind,
      adapter,
      spec: runSpec,
      worktree: worktree.path,
      attempt: task.attempts,
      parent: this.controller.signal,
      ...(onRunRecorded ? { onRunRecorded } : {}),
    });
  }

  /* -------------------------------------------------------------- runs */

  private async execute(options: {
    task: Task;
    kind: RunKind;
    adapter: HarnessAdapter;
    spec: ReturnType<typeof buildRunSpec>;
    worktree: string;
    attempt: number;
    parent: AbortSignal;
    onRunRecorded?: (run: Run) => void;
  }): Promise<RunOutcome> {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (options.parent.aborted) controller.abort();
    options.parent.addEventListener("abort", forward, { once: true });

    let registered: string | undefined;
    const permissions: Promise<void>[] = [];

    try {
      return await executeRun({
        store: this.store,
        adapter: options.adapter,
        config: this.config,
        threadId: this.threadId,
        task: options.task,
        kind: options.kind,
        spec: options.spec,
        worktree: options.worktree,
        attempt: options.attempt,
        signal: controller.signal,
        onRunRecorded: (run) => {
          registered = run.id;
          this.liveRuns.set(run.id, {
            runId: run.id,
            taskId: options.task.id,
            kind: options.kind,
            harness: options.adapter.id,
            adapter: options.adapter,
            controller,
            startedAt: run.startedAt,
          });
          void this.notify({
            type: "run_started",
            threadId: this.threadId,
            taskId: options.task.id,
            runId: run.id,
            kind: options.kind,
            harness: options.adapter.id,
            attempt: options.attempt,
          });
          options.onRunRecorded?.(run);
        },
        hooks: {
          onCost: (_runId, cost) => {
            this.applyCost(options.task.id, cost);
          },
          onPermission: (runId, event) => {
            permissions.push(this.answerPermission(options.adapter, options.task, runId, event));
          },
        },
      }).then((outcome) => {
        void this.notify({
          type: "run_ended",
          threadId: this.threadId,
          taskId: options.task.id,
          runId: outcome.runId,
          kind: options.kind,
          ok: outcome.ok,
          ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
          ...(outcome.error
            ? { error: outcome.error.message, retryable: outcome.error.retryable }
            : {}),
        });
        return outcome;
      });
    } finally {
      options.parent.removeEventListener("abort", forward);
      if (registered) this.liveRuns.delete(registered);
      await Promise.allSettled(permissions);
    }
  }

  /**
   * Answer a mid-run permission request.
   *
   * Runs beside the event stream rather than inside it: blocking the iterator
   * on a human would stop the harness' own output from being persisted, and a
   * harness that needs the answer to continue would deadlock.
   */
  private async answerPermission(
    adapter: HarnessAdapter,
    task: Task,
    runId: string,
    event: Extract<HarnessEvent, { type: "permission_request" }>,
  ): Promise<void> {
    try {
      const approval = await requestApproval(
        this.store,
        {
          threadId: this.threadId,
          kind: "permission",
          title: `Permission requested by ${adapter.id}`,
          description: event.description,
          risk: event.risk,
          taskId: task.id,
          runId,
        },
        this.controller.signal,
        (created) =>
          void this.notify({
            type: "approval_requested",
            threadId: this.threadId,
            approval: created,
          }),
      );
      void this.notify({ type: "approval_resolved", threadId: this.threadId, approval });
      await adapter.control(runId, {
        action: "answer_permission",
        requestId: event.requestId,
        approved: approval.status === "approved",
      });
    } catch (error) {
      if (error instanceof AbortedError) return;
      this.config.logger.warn(`orchestrator: could not answer permission on ${runId}`, error);
    }
  }

  /* ------------------------------------------------------- verification */

  async verify(
    taskId: string,
    criterionIds: readonly string[] | undefined,
    options: { signal?: AbortSignal; waitForManual?: boolean; worktree?: string } = {},
  ): Promise<RunVerificationResult> {
    const task = this.requireTask(taskId);
    const spec = this.store.getSpec(this.threadId);
    const wanted = criterionIds ? new Set(criterionIds) : undefined;
    const criteria = criteriaForTask(spec, task).filter(
      (criterion) => !wanted || wanted.has(criterion.id),
    );

    const workspace = this.workspace();
    const cwd =
      options.worktree ??
      this.latestRunFor(taskId)?.worktreePath ??
      worktreePathFor(this.config.worktreeRoot, this.threadId, taskId);

    const outcomes: VerificationOutcome[] = [];
    for (const criterion of criteria) {
      if (options.signal?.aborted) break;
      outcomes.push(await this.verifyCriterion(task, criterion, cwd, options, workspace.rootPath));
    }

    if (spec && outcomes.length > 0) this.applyOutcomesToSpec(spec, outcomes);

    void this.notify({
      type: "verification_completed",
      threadId: this.threadId,
      taskId,
      passed: outcomes.every((outcome) => outcome.passed),
      outcomes,
    });
    return { taskId, outcomes };
  }

  private async verifyCriterion(
    task: Task,
    criterion: AcceptanceCriterion,
    cwd: string,
    options: { signal?: AbortSignal; waitForManual?: boolean },
    repo: string,
  ): Promise<VerificationOutcome> {
    if (criterion.verification.kind === "manual_review") {
      const approval = createApproval(this.store, {
        threadId: this.threadId,
        kind: "manual_verification",
        title: `Verify: ${criterion.text}`,
        description: criterion.verification.instructions,
        taskId: task.id,
      });
      void this.notify({ type: "approval_requested", threadId: this.threadId, approval });

      const resolved = options.waitForManual
        ? await waitForApproval(this.store, approval, options.signal).catch(
            (error: unknown): undefined => {
              if (error instanceof AbortedError) return undefined;
              throw error;
            },
          )
        : this.store.getApproval(approval.id);

      const passed = resolved?.status === "approved";
      if (resolved && resolved.status !== "pending") {
        void this.notify({
          type: "approval_resolved",
          threadId: this.threadId,
          approval: resolved,
        });
      }
      const artifact = await writeArtifact({
        store: this.store,
        threadId: this.threadId,
        taskId: task.id,
        kind: "log",
        title: `Manual verification — ${criterion.id}`,
        content: [
          `criterion: ${criterion.id}`,
          `text: ${criterion.text}`,
          `instructions: ${criterion.verification.instructions}`,
          `approval: ${approval.id}`,
          `status: ${resolved?.status ?? "pending"}`,
          ...(resolved?.resolvedBy ? [`resolved by: ${resolved.resolvedBy}`] : []),
          "",
        ].join("\n"),
        maxBytes: this.config.maxArtifactBytes,
      });
      return {
        criterionId: criterion.id,
        passed,
        ...(passed ? { evidenceArtifactId: artifact.id } : {}),
        output: `manual verification ${resolved?.status ?? "pending"} (approval ${approval.id})`,
      };
    }

    const evidence = await runVerificationCommand({
      verification: criterion.verification,
      cwd,
      timeoutMs: this.config.verificationTimeoutMs,
      env: { ...this.config.env, NEXESTRA_REPO: repo },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    const artifact = await writeArtifact({
      store: this.store,
      threadId: this.threadId,
      taskId: task.id,
      kind: criterion.verification.kind === "test" ? "test_report" : "log",
      title: `Verification ${evidence.passed ? "pass" : "fail"} — ${criterion.id}`,
      content: renderEvidence(criterion, evidence, cwd),
      maxBytes: this.config.maxArtifactBytes,
    });

    return {
      criterionId: criterion.id,
      passed: evidence.passed,
      evidenceArtifactId: artifact.id,
      ...(evidence.exitCode !== undefined ? { exitCode: evidence.exitCode } : {}),
      output: summariseEvidence(evidence),
    };
  }

  /** Write evidence back onto the spec in one version bump, not one per criterion. */
  private applyOutcomesToSpec(spec: Spec, outcomes: readonly VerificationOutcome[]): void {
    const byId = new Map(outcomes.map((outcome) => [outcome.criterionId, outcome]));
    let changed = false;
    const acceptanceCriteria = spec.acceptanceCriteria.map((criterion) => {
      const outcome = byId.get(criterion.id);
      if (!outcome) return criterion;
      const satisfied = outcome.passed;
      const evidenceArtifactId = outcome.passed ? outcome.evidenceArtifactId : undefined;
      if (
        criterion.satisfied === satisfied &&
        criterion.evidenceArtifactId === evidenceArtifactId
      ) {
        return criterion;
      }
      changed = true;
      return {
        ...criterion,
        satisfied,
        ...(evidenceArtifactId ? { evidenceArtifactId } : { evidenceArtifactId: undefined }),
      };
    });
    if (changed) this.store.upsertSpec(this.threadId, { acceptanceCriteria });
  }

  markCriterion(input: { criterionId: string; passed: boolean; evidenceArtifactId?: string }): {
    criterionId: string;
    satisfied: boolean;
  } {
    const spec = this.store.getSpec(this.threadId);
    if (!spec) return { criterionId: input.criterionId, satisfied: false };
    const satisfied = input.passed && input.evidenceArtifactId !== undefined;
    this.applyOutcomesToSpec(spec, [
      {
        criterionId: input.criterionId,
        passed: satisfied,
        ...(input.evidenceArtifactId ? { evidenceArtifactId: input.evidenceArtifactId } : {}),
      },
    ]);
    return { criterionId: input.criterionId, satisfied };
  }

  /* ------------------------------------------------------ commit / merge */

  private async finalize(
    task: Task,
    worktree: string,
    branch: string,
    workspace: Workspace,
  ): Promise<void> {
    const into = this.baseBranch(workspace);
    const commit = await commitWorktree(
      worktree,
      `nexestra(${task.id}): ${task.title}`,
      this.config.commitIdentity,
    );

    if (!commit.committed) {
      this.setStatus(task, "done");
      this.config.logger.debug(
        `orchestrator: task ${task.id} produced no commit (${commit.detail ?? "no changes"})`,
      );
      return;
    }

    if (!this.config.autoMerge) {
      const approval = createApproval(this.store, {
        threadId: this.threadId,
        kind: "merge",
        title: `Merge ${branch} into ${into}`,
        description: `Task "${task.title}" passed verification. Commit ${commit.sha ?? ""} on ${branch} is ready to land in ${into}.`,
        taskId: task.id,
      });
      void this.notify({ type: "approval_requested", threadId: this.threadId, approval });
      this.store.updateTask(task.id, { mergeState: "pending" });
      this.setStatus(this.requireTask(task.id), "done");
      void this.notify({
        type: "merge",
        threadId: this.threadId,
        taskId: task.id,
        branch,
        into,
        result: "pending_approval",
      });
      return;
    }

    // Merges are serialised: two tasks landing on the same base branch at the
    // same time is exactly the conflict PLAN.md §9 warns about.
    const result = await this.enqueueMerge(() =>
      mergeTaskBranch({
        repo: workspace.rootPath,
        branch,
        into,
        identity: this.config.commitIdentity,
        message: `Merge ${branch}: ${task.title}`,
      }),
    );

    if (result.outcome === "merged" || result.outcome === "up_to_date") {
      this.store.updateTask(task.id, { mergeState: "merged" });
      this.setStatus(this.requireTask(task.id), "done");
      void this.notify({
        type: "merge",
        threadId: this.threadId,
        taskId: task.id,
        branch,
        into,
        result: "merged",
        ...(result.strategy ? { detail: result.strategy } : {}),
      });
      return;
    }

    const approval = createApproval(this.store, {
      threadId: this.threadId,
      kind: "merge",
      title: `Resolve merge of ${branch} into ${into}`,
      description: `Automatic merge failed: ${result.detail ?? result.outcome}`,
      risk: "high",
      taskId: task.id,
    });
    void this.notify({ type: "approval_requested", threadId: this.threadId, approval });
    this.store.updateTask(task.id, {
      mergeState: result.outcome === "conflict" ? "conflict" : "pending",
    });
    this.setStatus(this.requireTask(task.id), "done");
    void this.notify({
      type: "merge",
      threadId: this.threadId,
      taskId: task.id,
      branch,
      into,
      result: result.outcome === "conflict" ? "conflict" : "pending_approval",
      ...(result.detail ? { detail: result.detail } : {}),
    });
  }

  private enqueueMerge<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mergeQueue.then(fn, fn);
    this.mergeQueue = next.catch(() => undefined);
    return next;
  }

  /* --------------------------------------------------------------- money */

  private applyCost(taskId: string, costUSD: number): void {
    if (costUSD <= 0) return;
    const task = this.store.getTask(taskId);
    if (task) this.store.updateTask(taskId, { costUSD: task.costUSD + costUSD });
    const thread = this.store.getThread(this.threadId);
    if (thread) this.store.updateThread(this.threadId, { costUSD: thread.costUSD + costUSD });
    this.checkBudget();
  }

  /** False when the thread is out of money; also raises the 80% approval. */
  private checkBudget(): boolean {
    const thread = this.store.getThread(this.threadId);
    if (!thread) return true;
    const budgetUSD = this.config.budgetUSD ?? thread.budgetUSD;
    const state = budgetState(thread.costUSD, budgetUSD, BUDGET_WARNING_RATIO);

    if (state.level === "ok") return true;

    if (state.level === "warning") {
      if (!this.budgetWarned) {
        this.budgetWarned = true;
        const approval = createApproval(this.store, {
          threadId: this.threadId,
          kind: "spend",
          title: `Thread has spent ${state.costUSD.toFixed(2)} of ${budgetUSD.toFixed(2)} USD`,
          description:
            "The thread has passed 80% of its budget. Approve to keep going, reject to stop " +
            "dispatching new runs.",
          risk: "high",
        });
        void this.notify({ type: "approval_requested", threadId: this.threadId, approval });
        void this.notify({
          type: "budget_warning",
          threadId: this.threadId,
          costUSD: state.costUSD,
          budgetUSD,
        });
      }
      return true;
    }

    if (this.state === "running") this.state = "paused";
    this.lastOutcome = "budget_exceeded";
    void this.notify({
      type: "budget_exceeded",
      threadId: this.threadId,
      costUSD: state.costUSD,
      budgetUSD,
    });
    return false;
  }

  /* --------------------------------------------------------------- utils */

  private async replan(
    task: Task,
    reason: string,
    evidence: {
      runIds: readonly string[];
      artifactIds: readonly string[];
      lastError?: string;
      reviewFindings?: readonly ReviewFinding[];
      verification?: readonly VerificationOutcome[];
    },
  ): Promise<void> {
    void this.notify({
      type: "replan_requested",
      threadId: this.threadId,
      taskId: task.id,
      reason,
    });
    try {
      await this.master.requestReplan(task.id, reason, {
        threadId: this.threadId,
        taskId: task.id,
        attempts: task.attempts,
        maxAttempts: Math.min(task.maxAttempts, this.config.maxAttempts),
        runIds: [...evidence.runIds],
        artifactIds: [...evidence.artifactIds],
        ...(evidence.lastError ? { lastError: evidence.lastError } : {}),
        ...(evidence.reviewFindings?.length
          ? { reviewFindings: [...evidence.reviewFindings] }
          : {}),
        ...(evidence.verification?.length ? { verification: [...evidence.verification] } : {}),
      });
    } catch (error) {
      this.config.logger.error("orchestrator: requestReplan rejected", error);
    }
  }

  private async notify(event: OrchestratorEvent): Promise<void> {
    try {
      await this.master.notify(event);
    } catch (error) {
      this.config.logger.warn("orchestrator: MasterBridge.notify rejected", error);
    }
  }

  private setStatus(task: Task, status: TaskStatus): Task {
    if (task.status === status) return task;
    const updated = this.store.updateTask(task.id, { status });
    void this.notify({
      type: "task_status",
      threadId: this.threadId,
      taskId: task.id,
      from: task.status,
      to: status,
    });
    return updated;
  }

  private safeStatus(taskId: string, status: TaskStatus): void {
    const task = this.store.getTask(taskId);
    if (task) this.setStatus(task, status);
  }

  private requireTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`task ${taskId} not found in thread ${this.threadId}`);
    return task;
  }

  private workspace(): Workspace {
    const thread = this.store.getThread(this.threadId);
    if (!thread) throw new Error(`thread ${this.threadId} not found`);
    const workspace = this.store.getWorkspace(thread.workspaceId);
    if (!workspace) throw new Error(`workspace ${thread.workspaceId} not found`);
    return workspace;
  }

  private baseBranch(workspace: Workspace): string {
    return this.config.baseBranch ?? workspace.defaultBranch;
  }

  private harnessFor(task: Task, override?: HarnessId): { id: HarnessId; adapter: HarnessAdapter } {
    const wanted = override ?? task.assignedHarness;
    if (wanted) {
      const adapter = this.adapters[wanted];
      if (adapter) return { id: wanted, adapter };
      throw new Error(`no adapter registered for harness "${wanted}"`);
    }
    const first = Object.entries(this.adapters).find(([, adapter]) => adapter !== undefined);
    if (!first?.[1]) throw new Error("no harness adapters registered");
    return { id: first[0] as HarnessId, adapter: first[1] };
  }

  /** A harness other than the executor, for the cross-review pass. */
  private reviewerFor(executor: HarnessId): { id: HarnessId; adapter: HarnessAdapter } | undefined {
    for (const [id, adapter] of Object.entries(this.adapters)) {
      if (!adapter || id === executor) continue;
      return { id: id as HarnessId, adapter };
    }
    return undefined;
  }
}

function outcomeFor(tasks: readonly Task[]): ThreadOutcome {
  if (tasks.length === 0) return "completed";
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.every((task) => task.status === "done")) return "completed";
  return "blocked";
}
