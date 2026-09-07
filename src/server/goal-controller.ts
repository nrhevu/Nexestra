import { ControlWorkGoalSchema, type WorkGoal } from "../shared/goals.js";
import type { AgentDispatcher } from "./dispatcher.js";
import { type FileStore, StoreError } from "./store.js";

/** An event-driven, WIP=1 loop. Human review supplies the independent continuation decision. */
export class GoalController {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly pending = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(
    private readonly store: FileStore,
    private readonly dispatcher: AgentDispatcher,
  ) {
    this.unsubscribe = dispatcher.subscribeAssignmentEnd((assignmentId) => {
      const assignment = store.listAssignments().find((entry) => entry.id === assignmentId);
      if (assignment?.goalId) void this.kick(assignment.goalId).catch(() => undefined);
    });
  }

  async control(id: string, rawInput: unknown): Promise<WorkGoal> {
    const input = ControlWorkGoalSchema.parse(rawInput);
    const goal = await this.store.controlGoal(id, input);
    if (input.action === "start") {
      this.armDeadline(goal);
      await this.kick(id);
    } else {
      this.clearTimer(id);
      await this.stopAssignment(goal);
    }
    return this.store.getGoal(id) ?? goal;
  }

  async taskReviewed(taskId: string): Promise<void> {
    await Promise.all(
      this.store
        .listGoals()
        .filter(
          (goal) =>
            ["active", "waiting_review", "paused"].includes(goal.status) &&
            goal.steps.some((step) => step.taskId === taskId),
        )
        .map((goal) => this.kick(goal.id)),
    );
  }

  kick(id: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pending.add(id);
    const existing = this.flights.get(id);
    if (existing) return existing;
    const execution = (async () => {
      while (this.pending.delete(id) && !this.disposed) {
        try {
          await this.advance(id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "Goal continuation failed.";
          await this.store.stopGoal(
            id,
            "blocked",
            `${reason} Inspect the checkpoint before resuming.`,
          );
          this.clearTimer(id);
        }
      }
    })();
    this.flights.set(id, execution);
    void execution
      .finally(() => {
        if (this.flights.get(id) === execution) this.flights.delete(id);
      })
      .catch(() => undefined);
    return execution;
  }

  async waitForIdle(): Promise<void> {
    while (this.flights.size) await Promise.all([...this.flights.values()]);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    for (const id of this.timers.keys()) this.clearTimer(id);
  }

  private async advance(id: string): Promise<void> {
    const goal = await this.store.reconcileGoal(id);
    if (!["active", "waiting_review"].includes(goal.status)) {
      this.clearTimer(id);
      if (goal.status === "exhausted" || goal.status === "blocked") await this.stopAssignment(goal);
      return;
    }
    this.armDeadline(goal);
    const check = this.store.inspectGoal(id);
    if (!check.next) return;
    const worker = this.store.getAgent(check.next.workerAgentId);
    const repository = check.next.repositoryId
      ? this.store
          .listKnowledge(goal.workspaceId)
          .find((entry) => entry.id === check.next?.repositoryId)
      : undefined;
    if (worker?.kind !== "worker" || !worker.enabled || worker.archived)
      throw new StoreError(
        "invalid",
        "The selected Worker is unavailable. Restore it before resuming this goal.",
      );
    if (
      check.next.repositoryId &&
      (repository?.kind !== "repository" || repository.status !== "ready")
    )
      throw new StoreError("invalid", "The goal's repository is not ready.");
    await this.dispatcher.delegateFromTask(
      check.next.taskId,
      worker.handle,
      repository?.handle,
      check.next.contract.revision,
      goal.id,
    );
  }

  private async stopAssignment(goal: WorkGoal): Promise<void> {
    if (!goal.activeAssignmentId) return;
    const assignment = this.store
      .listAssignments(goal.workspaceId)
      .find((entry) => entry.id === goal.activeAssignmentId);
    if (!assignment || !["queued", "running"].includes(assignment.status)) return;
    try {
      await this.dispatcher.stopTask(assignment.taskId);
    } catch (error) {
      if (!(error instanceof StoreError && error.code === "conflict")) throw error;
    }
  }

  private armDeadline(goal: WorkGoal): void {
    if (!goal.deadlineAt || this.timers.has(goal.id)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(goal.id);
        void this.kick(goal.id).catch(() => undefined);
      },
      Math.max(1, Date.parse(goal.deadlineAt) - Date.now()),
    );
    timer.unref();
    this.timers.set(goal.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
}
