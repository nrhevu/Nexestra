import {
  type Agent,
  type AgentRun,
  CreateMessageSchema,
  extractKnowledgeHandles,
  extractMentionHandles,
  type Message,
  type RunActivity,
  type Task,
  type TaskProcessData,
  type ThreadStreamEvent,
  type ToolCall,
  UpdateAgentSchema,
  type WorkAssignment,
} from "../shared/contracts.js";
import { runCommand, safeProcessEnv } from "./process.js";
import { type AssignmentRepositoryManager, RepositoryManager } from "./repository-manager.js";
import {
  type AgentInvocation,
  type AgentRunner,
  agentView,
  type RuntimeToolUpdate,
} from "./runtime.js";
import { type FileStore, StoreError, type UploadArtifactInput } from "./store.js";

export class AgentDispatcher {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly pendingEnqueues = new Map<string, number>();
  private readonly changingAgentIds = new Set<string>();
  private readonly retryingRunIds = new Set<string>();
  private readonly delegatingTaskIds = new Set<string>();
  private readonly assignmentCompletions = new Set<Promise<unknown>>();
  private readonly liveRuns = new Map<string, AgentRun>();
  private readonly liveActivities = new Map<string, RunActivity>();
  private readonly runControllers = new Map<string, AbortController>();
  private readonly stoppingRunIds = new Set<string>();
  private static readonly MAX_AUTO_RETRIES = 2;
  private static readonly VERIFICATION_TIMEOUT_MS = 5 * 60_000;
  private static readonly VERIFICATION_MAX_OUTPUT_BYTES = 64 * 1024;
  private readonly threadSubscribers = new Map<string, Set<(event: ThreadStreamEvent) => void>>();
  private readonly threadRevisions = new Map<string, number>();
  private readonly pendingApprovals = new Map<
    string,
    { runId: string; resolve: (approved: boolean) => void }
  >();
  private readonly pendingInputs = new Map<
    string,
    { runId: string; resolve: (answers: string[][]) => void }
  >();

  constructor(
    private readonly store: FileStore,
    private readonly runner: AgentRunner,
    private readonly repositories: AssignmentRepositoryManager = new RepositoryManager(store),
  ) {}

  busyAgentIds(): ReadonlySet<string> {
    return new Set(this.busy);
  }

  activeRuns(workspaceId?: string): AgentRun[] {
    return [...this.liveRuns.values()]
      .filter((run) => {
        if (workspaceId === undefined) return true;
        return this.store.getThread(run.threadId)?.workspaceId === workspaceId;
      })
      .map((run) => structuredClone(run));
  }

  async taskProcess(taskId: string): Promise<TaskProcessData> {
    const task = this.store.getTask(taskId);
    if (!task) throw new StoreError("not_found", "Task not found.");
    const assignments = this.store
      .listAssignments(task.workspaceId)
      .filter((entry) => entry.taskId === task.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const assignment = assignments.at(-1);
    if (!assignment) return { task, assignments, toolCalls: [] };
    const thread = await this.store.threadData(assignment.threadId);
    const run = thread.runs.find((entry) => entry.id === assignment.id);
    const activity = this.liveActivities.get(assignment.id);
    return {
      task,
      assignment,
      assignments,
      ...(run ? { run } : {}),
      ...(activity ? { activity: structuredClone(activity) } : {}),
      toolCalls: thread.toolCalls.filter((toolCall) => toolCall.runId === assignment.id),
    };
  }

  async stopTask(taskId: string): Promise<TaskProcessData> {
    const task = this.store.getTask(taskId);
    if (!task) throw new StoreError("not_found", "Task not found.");
    const assignment = this.store
      .listAssignments(task.workspaceId)
      .find((entry) => entry.taskId === task.id && ["queued", "running"].includes(entry.status));
    if (!assignment) {
      throw new StoreError("conflict", "This task does not have an active Worker process.");
    }
    this.stoppingRunIds.add(assignment.id);
    const controller = this.runControllers.get(assignment.id);
    const run = this.liveRuns.get(assignment.id);
    if (run) this.updateActivity(run, "tool", "Stopping Worker");
    controller?.abort(new Error("Worker process stopped by the user."));
    try {
      await this.persistStoppedAssignment(task, assignment);
      this.notifyThread(assignment.threadId, true);
      return this.taskProcess(task.id);
    } finally {
      if (!controller) this.stoppingRunIds.delete(assignment.id);
    }
  }

  threadStreamSnapshot(threadId: string, refresh = true): ThreadStreamEvent {
    return {
      revision: this.threadRevisions.get(threadId) ?? 0,
      refresh,
      activities: [...this.liveActivities.values()]
        .filter((activity) => activity.threadId === threadId)
        .map((activity) => structuredClone(activity)),
    };
  }

  subscribeThread(threadId: string, listener: (event: ThreadStreamEvent) => void): () => void {
    const listeners = this.threadSubscribers.get(threadId) ?? new Set();
    listeners.add(listener);
    this.threadSubscribers.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.threadSubscribers.delete(threadId);
    };
  }

  hasPendingWork(agentId: string): boolean {
    return (
      this.busy.has(agentId) ||
      this.queues.has(agentId) ||
      (this.pendingEnqueues.get(agentId) ?? 0) > 0
    );
  }

  beginAgentMutation(agentId: string): boolean {
    if (this.changingAgentIds.has(agentId) || this.hasPendingWork(agentId)) return false;
    this.changingAgentIds.add(agentId);
    return true;
  }

  finishAgentMutation(agentId: string): void {
    this.changingAgentIds.delete(agentId);
  }

  async updateAgent(agentId: string, rawInput: unknown): Promise<Agent> {
    const input = UpdateAgentSchema.parse(rawInput);
    const changesConfiguration = Object.keys(input).some(
      (key) => key !== "enabled" && key !== "archived",
    );
    if (!changesConfiguration) return this.store.updateAgent(agentId, input);
    if (!this.beginAgentMutation(agentId)) {
      throw new StoreError(
        "conflict",
        "Wait for the agent's current work or configuration change to finish before editing it.",
      );
    }
    try {
      return await this.store.updateAgent(agentId, input);
    } finally {
      this.finishAgentMutation(agentId);
    }
  }

  resolveToolApproval(toolCallId: string, approved: boolean): void {
    const approval = this.pendingApprovals.get(toolCallId);
    if (!approval) throw new StoreError("not_found", "Pending tool approval not found.");
    this.pendingApprovals.delete(toolCallId);
    approval.resolve(approved);
  }

  resolveToolInput(toolCallId: string, answers: string[][]): void {
    const input = this.pendingInputs.get(toolCallId);
    if (!input) throw new StoreError("not_found", "Pending tool question not found.");
    this.pendingInputs.delete(toolCallId);
    input.resolve(answers);
  }

  reserveAgent(agentId: string): (() => void) | undefined {
    if (this.changingAgentIds.has(agentId)) return undefined;
    this.pendingEnqueues.set(agentId, (this.pendingEnqueues.get(agentId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.pendingEnqueues.get(agentId) ?? 1) - 1;
      if (remaining === 0) this.pendingEnqueues.delete(agentId);
      else this.pendingEnqueues.set(agentId, remaining);
    };
  }

  async enqueue(trigger: Message, agents: Agent[], attempt = 1): Promise<AgentRun[]> {
    const releases: (() => void)[] = [];
    for (const agent of agents) {
      const release = this.reserveAgent(agent.id);
      if (!release) {
        for (const releaseReservedAgent of releases) releaseReservedAgent();
        throw new StoreError("conflict", `@${agent.handle} is being updated or deleted.`);
      }
      releases.push(release);
    }
    try {
      const runs: AgentRun[] = [];
      for (const agent of agents) {
        const now = new Date().toISOString();
        const run: AgentRun = {
          id: crypto.randomUUID(),
          threadId: trigger.threadId,
          triggerMessageId: trigger.id,
          agentId: agent.id,
          attempt,
          status: "queued",
          createdAt: now,
          updatedAt: now,
        };
        const queued = await this.store.updateRun(run);
        this.liveRuns.set(queued.id, queued);
        this.liveActivities.set(queued.id, {
          runId: queued.id,
          threadId: queued.threadId,
          agentId: queued.agentId,
          stage: "queued",
          thinking: "",
          text: "",
          detail: "Waiting in the queue",
          updatedAt: now,
        });
        this.notifyThread(queued.threadId, true);
        runs.push(queued);
        this.enqueueRun(queued, agent, trigger);
      }
      return runs;
    } finally {
      for (const release of releases) release();
    }
  }

  async retry(runId: string): Promise<AgentRun> {
    if (this.retryingRunIds.has(runId)) {
      throw new StoreError("conflict", "This run is already being retried.");
    }
    this.retryingRunIds.add(runId);
    try {
      const assignment = this.store.listAssignments().find((entry) => entry.id === runId);
      if (assignment) {
        const process = await this.taskProcess(assignment.taskId);
        if (process.assignment?.id !== assignment.id) {
          throw new StoreError("conflict", "A newer assignment already exists for this task.");
        }
        if (assignment.status !== "failed" && assignment.status !== "interrupted") {
          throw new StoreError("invalid", "Only failed or interrupted Worker runs can be retried.");
        }
        const worker = this.store.getAgent(assignment.workerAgentId);
        const repository = this.store.getKnowledge(assignment.repositoryId);
        if (!worker || !repository) {
          throw new StoreError(
            "not_found",
            "The Worker's profile or repository is no longer available.",
          );
        }
        const retried = await this.delegateFromTask(
          assignment.taskId,
          worker.handle,
          repository.handle,
        );
        const data = await this.store.threadData(retried.threadId);
        const run = data.runs.find((entry) => entry.id === retried.id);
        if (!run) throw new StoreError("not_found", "The queued Worker run could not be loaded.");
        return run;
      }
      for (const thread of this.store.listThreads()) {
        const data = await this.store.threadData(thread.id);
        const previous = data.runs.find((run) => run.id === runId);
        if (!previous) continue;
        if (previous.status !== "failed" && previous.status !== "interrupted") {
          throw new StoreError("invalid", "Only failed or interrupted runs can be retried.");
        }
        const latest = data.runs
          .filter(
            (run) =>
              run.triggerMessageId === previous.triggerMessageId &&
              run.agentId === previous.agentId,
          )
          .sort((left, right) => right.attempt - left.attempt)[0];
        if (latest?.id !== previous.id) {
          throw new StoreError("conflict", "A newer attempt already exists for this run.");
        }
        const trigger = data.messages.find((message) => message.id === previous.triggerMessageId);
        const agent = this.store.getAgent(previous.agentId);
        if (!trigger || !agent) {
          throw new StoreError("not_found", "There is not enough data to retry this run.");
        }
        const [run] = await this.enqueue(trigger, [agent], previous.attempt + 1);
        if (!run) throw new Error("Could not create a retry run.");
        return run;
      }
      throw new StoreError("not_found", "Run not found.");
    } finally {
      this.retryingRunIds.delete(runId);
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.queues.size > 0 || this.assignmentCompletions.size > 0) {
      await Promise.all([...this.queues.values(), ...this.assignmentCompletions]);
    }
  }

  private enqueueRun(run: AgentRun, agent: Agent, trigger: Message): void {
    const previous = this.queues.get(agent.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.execute(run, agent, trigger));
    this.queues.set(agent.id, current);
    const cleanup = () => {
      if (this.queues.get(agent.id) === current) this.queues.delete(agent.id);
    };
    void current.then(cleanup, cleanup);
  }

  private async execute(run: AgentRun, agent: Agent, trigger: Message): Promise<void> {
    this.busy.add(agent.id);
    let currentRun = run;
    try {
      const runtime = await this.runner.runtimeStatus();
      const readiness = agentView(agent, runtime, new Set());
      if (readiness.readiness !== "ready") throw new Error(readiness.readinessLabel);
      const running = await this.store.updateRun({
        ...run,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
      currentRun = running;
      this.liveRuns.set(running.id, running);
      this.updateActivity(running, "thinking", "Starting agent");
      this.notifyThread(running.threadId, true);
      const thread = this.store.getThread(run.threadId);
      if (!thread) throw new StoreError("not_found", "Thread not found.");
      const [transcriptSnapshot, artifacts, knowledge] = await Promise.all([
        this.store.transcriptSnapshot(run.threadId),
        this.store.agentArtifacts(run.threadId, trigger.id),
        this.store.agentKnowledge(trigger),
      ]);
      const pendingInteractions = new Map<string, "waiting_approval" | "waiting_input">();
      let runStatusQueue: Promise<void> = Promise.resolve();
      const refreshInteractionStatus = async (): Promise<void> => {
        const update = runStatusQueue.then(async () => {
          const status = [...pendingInteractions.values()].at(-1) ?? "running";
          currentRun = await this.store.updateRun({
            ...currentRun,
            status,
            updatedAt: new Date().toISOString(),
          });
          this.liveRuns.set(currentRun.id, currentRun);
          const detail =
            status === "waiting_approval"
              ? "Waiting for tool approval"
              : status === "waiting_input"
                ? "Waiting for your answer"
                : "Working";
          this.updateActivity(currentRun, status === "running" ? "thinking" : "tool", detail);
          this.notifyThread(currentRun.threadId, true);
        });
        runStatusQueue = update.catch(() => undefined);
        return update;
      };
      const runtimeToolCalls = new Map<string, ToolCall>();
      const invocation: AgentInvocation = {
        runId: run.id,
        thread,
        trigger,
        transcriptPath: this.store.transcriptPath(run.threadId),
        transcriptSnapshot,
        artifacts,
        knowledge,
        toolHooks: {
          update: async (toolCall) => {
            await this.store.updateToolCall(toolCall);
            this.updateActivity(
              currentRun,
              "tool",
              `${toolCall.status.replace("_", " ")} ${toolCall.name}`,
            );
            this.notifyThread(run.threadId, true);
          },
          requestApproval: async (toolCall) => {
            const decision = new Promise<boolean>((resolve) => {
              this.pendingApprovals.set(toolCall.id, { runId: run.id, resolve });
            });
            try {
              await this.store.updateToolCall(toolCall);
              this.notifyThread(run.threadId, true);
              pendingInteractions.set(toolCall.id, "waiting_approval");
              await refreshInteractionStatus();
              return await decision;
            } finally {
              this.pendingApprovals.delete(toolCall.id);
              pendingInteractions.delete(toolCall.id);
              await refreshInteractionStatus();
            }
          },
          requestInput: async (toolCall) => {
            const response = new Promise<string[][]>((resolve) => {
              this.pendingInputs.set(toolCall.id, { runId: run.id, resolve });
            });
            try {
              await this.store.updateToolCall(toolCall);
              this.notifyThread(run.threadId, true);
              pendingInteractions.set(toolCall.id, "waiting_input");
              await refreshInteractionStatus();
              return await response;
            } finally {
              this.pendingInputs.delete(toolCall.id);
              pendingInteractions.delete(toolCall.id);
              await refreshInteractionStatus();
            }
          },
          createPlan: async (title, steps) => {
            const tasks = [];
            for (const step of steps) {
              tasks.push(
                await this.store.createTask({
                  workspaceId: thread.workspaceId,
                  title: step.title,
                  description: [title, step.description].filter(Boolean).join("\n\n"),
                  status: "todo",
                  assigneeId: null,
                  threadId: thread.id,
                }),
              );
            }
            this.notifyThread(run.threadId, true);
            return tasks;
          },
          delegate: (input) =>
            this.delegateWork(currentRun, agent, trigger, transcriptSnapshot, input),
        },
        activityHooks: {
          status: (stage, detail) => this.updateActivity(currentRun, stage, detail),
          thinking: (value, mode) => this.updateActivityThinking(currentRun, value, mode),
          text: (value, mode) => this.updateActivityText(currentRun, value, mode),
          tool: async (update) => {
            const toolCall = this.runtimeToolCall(
              currentRun,
              update,
              runtimeToolCalls.get(update.id),
            );
            runtimeToolCalls.set(update.id, toolCall);
            await this.store.updateToolCall(toolCall);
            this.notifyThread(run.threadId, true);
          },
        },
      };
      const response = this.store.redactSecrets(
        (await this.runner.invoke(agent, invocation)).trim(),
      );
      if (!response) throw new Error("The agent returned an empty response.");
      await this.store.createAgentMessage(run.threadId, agent, response, trigger.id);
      await this.store.updateRun({
        ...currentRun,
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const errorMessage = this.store.redactSecrets(
        error instanceof Error ? error.message : "The agent encountered an unknown error.",
      );
      await this.store.updateRun({
        ...currentRun,
        status: "failed",
        error: errorMessage,
        updatedAt: new Date().toISOString(),
      });

      const isRetryable = this.isRetryableError(errorMessage);
      const retriesUsed = run.attempt - 1;

      if (isRetryable && retriesUsed < AgentDispatcher.MAX_AUTO_RETRIES) {
        this.notifyThread(run.threadId, true);
        console.log(
          `[Auto-retry] Run ${run.id} failed (retry ${retriesUsed + 1}/${AgentDispatcher.MAX_AUTO_RETRIES}): ${errorMessage}. Retrying...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 1000 * (retriesUsed + 1)));
        const now = new Date().toISOString();
        await this.execute(
          {
            ...run,
            id: crypto.randomUUID(),
            attempt: run.attempt + 1,
            createdAt: now,
            updatedAt: now,
          },
          agent,
          trigger,
        );
      } else if (isRetryable) {
        console.log(
          `[Auto-retry] Run ${run.id} exhausted ${AgentDispatcher.MAX_AUTO_RETRIES} retries.`,
        );
      }
    } finally {
      for (const [toolCallId, approval] of this.pendingApprovals) {
        if (approval.runId !== run.id) continue;
        this.pendingApprovals.delete(toolCallId);
        approval.resolve(false);
      }
      for (const [toolCallId, input] of this.pendingInputs) {
        if (input.runId !== run.id) continue;
        this.pendingInputs.delete(toolCallId);
        input.resolve([]);
      }
      this.liveRuns.delete(run.id);
      this.liveActivities.delete(run.id);
      this.busy.delete(agent.id);
      this.notifyThread(run.threadId, true);
    }
  }

  // Return once the durable assignment is queued; the shared lifecycle records completion/failure.
  async delegateFromTask(
    taskId: string,
    workerHandle: string,
    repositoryHandle: string,
  ): Promise<WorkAssignment> {
    return new Promise<WorkAssignment>((resolve, reject) => {
      const completion = this.assignWorker(
        { taskId, workerHandle, repositoryHandle },
        undefined,
        resolve,
      )
        .catch(reject)
        .finally(() => this.assignmentCompletions.delete(completion));
      this.assignmentCompletions.add(completion);
    });
  }

  private async delegateWork(
    masterRun: AgentRun,
    master: Agent,
    trigger: Message,
    transcriptSnapshot: string,
    input: { taskId: string; workerHandle: string; repositoryHandle: string },
  ): Promise<{ assignment: WorkAssignment; result: string }> {
    if (master.kind !== "master") throw new StoreError("invalid", "Only Masters can delegate.");
    return this.assignWorker(input, { masterRun, master, trigger, transcriptSnapshot });
  }

  private async assignWorker(
    input: { taskId: string; workerHandle: string; repositoryHandle: string },
    origin?: { masterRun: AgentRun; master: Agent; trigger: Message; transcriptSnapshot: string },
    onQueued?: (assignment: WorkAssignment) => void,
  ): Promise<{ assignment: WorkAssignment; result: string }> {
    const task = this.store.getTask(input.taskId);
    if (!task) throw new StoreError("not_found", "Task not found.");
    if (!task.threadId) throw new StoreError("invalid", "Task must be linked to a thread.");
    const thread = this.store.getThread(task.threadId);
    if (!thread) throw new StoreError("not_found", "Thread not found.");
    if (
      task.workspaceId !== thread.workspaceId ||
      (origin && origin.masterRun.threadId !== thread.id)
    ) {
      throw new StoreError("invalid", "Delegation must use a task from this run's plan.");
    }
    if (task.status === "done") {
      throw new StoreError("conflict", "A completed task cannot be delegated again.");
    }
    if (
      this.delegatingTaskIds.has(task.id) ||
      this.store
        .listAssignments(thread.workspaceId)
        .some(
          (assignment) =>
            assignment.taskId === task.id &&
            (assignment.status === "queued" || assignment.status === "running"),
        )
    ) {
      throw new StoreError("conflict", "This planned task already has an assignment.");
    }
    const worker = this.store.findAgentByHandle(input.workerHandle, thread.workspaceId);
    if (worker?.kind !== "worker" || !worker.enabled || worker.archived) {
      throw new StoreError("invalid", `@${input.workerHandle} is not an available Worker.`);
    }
    const knowledge = this.store.findKnowledgeByHandle(input.repositoryHandle, thread.workspaceId);
    if (knowledge?.kind !== "repository") {
      throw new StoreError("invalid", `#${input.repositoryHandle} is not a repository.`);
    }
    if (knowledge.status !== "ready") {
      throw new StoreError(
        "invalid",
        `#${knowledge.handle} is not ready for delegation (status: ${knowledge.status}).`,
      );
    }
    const release = this.reserveAgent(worker.id);
    if (!release)
      throw new StoreError("conflict", `@${worker.handle} is being updated or deleted.`);
    this.delegatingTaskIds.add(task.id);
    const id = crypto.randomUUID();
    const controller = new AbortController();
    this.runControllers.set(id, controller);
    const location = this.repositories.assignmentLocation(thread.workspaceId, id);
    const now = new Date().toISOString();
    let workerRun: AgentRun = {
      id,
      threadId: thread.id,
      triggerMessageId: origin?.trigger.id ?? id,
      agentId: worker.id,
      attempt: 1,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    let assignment: WorkAssignment = {
      id,
      workspaceId: thread.workspaceId,
      taskId: task.id,
      threadId: thread.id,
      masterRunId: origin?.masterRun.id ?? "",
      workerAgentId: worker.id,
      repositoryId: knowledge.id,
      status: "queued",
      branch: location.branch,
      worktreePath: location.worktreePath,
      createdAt: now,
      updatedAt: now,
    };
    let workerRunPersisted = false;
    let assignmentPersisted = false;
    try {
      const trigger =
        origin?.trigger ??
        (await this.store.createUserMessage(
          thread.id,
          `@${worker.handle} implement task: ${task.title}\n\n${task.description}\n\nRepository: #${knowledge.handle}`,
          [{ agentId: worker.id, handle: worker.handle }],
          [],
          [{ knowledgeId: knowledge.id, handle: knowledge.handle }],
        ));
      const transcriptSnapshot =
        origin?.transcriptSnapshot ?? (await this.store.transcriptSnapshot(thread.id));
      workerRun.triggerMessageId = trigger.id;
      assignment = await this.store.createAssignment(assignment);
      assignmentPersisted = true;
      controller.signal.throwIfAborted();
      await this.store.updateTask(task.id, { status: "in_progress", assigneeId: worker.id });
      controller.signal.throwIfAborted();
      workerRun = await this.store.updateRun(workerRun);
      workerRunPersisted = true;
      this.liveRuns.set(workerRun.id, workerRun);
      this.liveActivities.set(workerRun.id, {
        runId: workerRun.id,
        threadId: workerRun.threadId,
        agentId: workerRun.agentId,
        stage: "queued",
        thinking: "",
        text: "",
        detail: "Waiting for the Worker",
        updatedAt: now,
      });
      this.notifyThread(thread.id, true);
      const completion = this.enqueueDelegation(worker.id, async () => {
        this.busy.add(worker.id);
        try {
          controller.signal.throwIfAborted();
          this.updateActivity(workerRun, "thinking", "Preparing an isolated worktree");
          const prepared = await this.repositories.prepareAssignment(
            knowledge,
            location,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          assignment = await this.store.updateAssignment(assignment.id, {
            status: "running",
            ...(prepared?.baseCommit ? { baseCommit: prepared.baseCommit } : {}),
          });
          workerRun = await this.store.updateRun({
            ...workerRun,
            status: "running",
            updatedAt: new Date().toISOString(),
          });
          this.liveRuns.set(workerRun.id, workerRun);
          this.updateActivity(workerRun, "thinking", "Starting Worker");
          this.notifyThread(thread.id, true);
          const delegatedTrigger: Message = {
            ...trigger,
            id: assignment.id,
            content: [
              origin
                ? `Assigned by @${origin.master.handle}.`
                : "Assigned by the local user from Taskboard.",
              `Task: ${task.title}`,
              task.description,
              `Repository: #${knowledge.handle}`,
              `Worktree: ${location.absolutePath}`,
              "Implement the task, verify the result, and commit your changes on the assigned branch. Do not merge or push.",
            ]
              .filter(Boolean)
              .join("\n\n"),
            mentions: [{ agentId: worker.id, handle: worker.handle }],
            knowledgeReferences: [{ knowledgeId: knowledge.id, handle: knowledge.handle }],
            artifactIds: [],
          };
          const runtimeToolCalls = new Map<string, ToolCall>();
          const rawResponse = (
            await this.runner.invoke(worker, {
              runId: assignment.id,
              thread,
              trigger: delegatedTrigger,
              transcriptPath: this.store.transcriptPath(thread.id),
              transcriptSnapshot,
              knowledge: [{ item: knowledge, localPath: location.absolutePath }],
              workingDirectory: location.absolutePath,
              mode: "task",
              signal: controller.signal,
              activityHooks: {
                status: (stage, detail) => this.updateActivity(workerRun, stage, detail),
                thinking: (value, mode) => this.updateActivityThinking(workerRun, value, mode),
                text: (value, mode) => this.updateActivityText(workerRun, value, mode),
                tool: async (update) => {
                  const toolCall = this.runtimeToolCall(
                    workerRun,
                    update,
                    runtimeToolCalls.get(update.id),
                  );
                  runtimeToolCalls.set(update.id, toolCall);
                  await this.store.updateToolCall(toolCall);
                  this.notifyThread(thread.id, true);
                },
              },
            })
          ).trim();
          const response = this.store.redactSecrets(rawResponse);
          controller.signal.throwIfAborted();
          if (!response) throw new Error("The Worker returned an empty response.");

          // Post the Worker's result to the thread
          await this.store.createAgentMessage(thread.id, worker, response, trigger.id);

          const result = response;
          controller.signal.throwIfAborted();
          this.updateActivity(workerRun, "tool", "Verifying the Worker result");
          this.notifyThread(thread.id, true);
          const verification = task.verificationCommand
            ? await this.runTaskVerification(task, location, controller.signal)
            : undefined;
          const verificationPassed =
            !task.verificationCommand || verification?.verificationExitCode === 0;
          const summaryMessage = [
            `## Worker @${worker.handle} ${verificationPassed ? "completed" : "finished with failed verification for"} task: **${task.title}**`,
            "",
            `> ${result.slice(0, 500)}${result.length > 500 ? "..." : ""}`,
            "",
            `**Branch:** \`${location.branch}\`  **Worktree:** \`${location.worktreePath}\``,
            ...(task.verificationCommand
              ? [
                  "",
                  `**Verification:** \`${task.verificationCommand}\``,
                  verificationPassed
                    ? "Exit code: 0"
                    : `Exit code: ${verification?.verificationExitCode}`,
                  ...(verification?.verificationOutput
                    ? ["", "```text", verification.verificationOutput, "```"]
                    : []),
                ]
              : []),
          ].join("\n");
          if (origin) {
            await this.store.createAgentMessage(
              thread.id,
              origin.master,
              summaryMessage,
              trigger.id,
            );
          }
          assignment = await this.store.updateAssignment(assignment.id, {
            status: "completed",
            result: result.slice(0, 20_000),
            ...(verification ?? {}),
          });
          controller.signal.throwIfAborted();
          await this.store.updateTask(task.id, {
            status: verificationPassed ? "done" : "blocked",
          });
          controller.signal.throwIfAborted();
          this.notifyThread(thread.id, true);
          workerRun = await this.store.updateRun({
            ...workerRun,
            status: "completed",
            updatedAt: new Date().toISOString(),
          });
          this.liveRuns.set(workerRun.id, workerRun);
          return { assignment, result };
        } finally {
          this.busy.delete(worker.id);
        }
      });
      onQueued?.(structuredClone(assignment));
      return await completion;
    } catch (error) {
      const stopped = controller.signal.aborted || this.stoppingRunIds.has(id);
      const message = this.store.redactSecrets(
        stopped
          ? "Worker process stopped by the user."
          : error instanceof Error
            ? error.message
            : "Worker assignment failed.",
      );
      if (stopped && assignmentPersisted) {
        await this.persistStoppedAssignment(task, {
          ...assignment,
          id,
          status: "interrupted",
        });
      } else if (workerRunPersisted) {
        workerRun = await this.store
          .updateRun({
            ...workerRun,
            status: "failed",
            error: message.slice(0, 2_000),
            updatedAt: new Date().toISOString(),
          })
          .catch(() => workerRun);
        const threadData = await this.store.threadData(thread.id);
        for (const toolCall of threadData.toolCalls.filter(
          (entry) =>
            entry.runId === id &&
            ["waiting_approval", "waiting_input", "running"].includes(entry.status),
        )) {
          await this.store.updateToolCall({
            ...toolCall,
            status: "failed",
            error: message.slice(0, 2_000),
            updatedAt: new Date().toISOString(),
          });
        }
      }
      if (!stopped && assignmentPersisted) {
        await this.store
          .updateAssignment(id, { status: "failed", error: message.slice(0, 2_000) })
          .catch(() => undefined);
        await this.store
          .updateTask(task.id, { status: "todo", assigneeId: null })
          .catch(() => undefined);
      }
      throw new StoreError("invalid", message);
    } finally {
      this.delegatingTaskIds.delete(task.id);
      this.runControllers.delete(id);
      this.stoppingRunIds.delete(id);
      this.liveRuns.delete(id);
      this.liveActivities.delete(id);
      this.notifyThread(thread.id, true);
      release();
    }
  }

  private async persistStoppedAssignment(task: Task, assignment: WorkAssignment): Promise<void> {
    const message = "Worker process stopped by the user.";
    const thread = await this.store.threadData(assignment.threadId);
    const run = thread.runs.find((entry) => entry.id === assignment.id);
    if (!run) {
      const masterRun = thread.runs.find((entry) => entry.id === assignment.masterRunId);
      if (masterRun) {
        await this.store.updateRun({
          id: assignment.id,
          threadId: assignment.threadId,
          triggerMessageId: masterRun.triggerMessageId,
          agentId: assignment.workerAgentId,
          attempt: 1,
          status: "interrupted",
          error: message,
          createdAt: assignment.createdAt,
          updatedAt: new Date().toISOString(),
        });
      }
    } else if (run.status !== "completed" && run.status !== "interrupted") {
      await this.store.updateRun({
        ...run,
        status: "interrupted",
        error: message,
        updatedAt: new Date().toISOString(),
      });
    }
    for (const toolCall of thread.toolCalls.filter(
      (entry) =>
        entry.runId === assignment.id &&
        ["waiting_approval", "waiting_input", "running"].includes(entry.status),
    )) {
      await this.store.updateToolCall({
        ...toolCall,
        status: "interrupted",
        error: message,
        updatedAt: new Date().toISOString(),
      });
    }
    await this.store.updateAssignment(assignment.id, {
      status: "interrupted",
      error: message,
    });
    await this.store.updateTask(task.id, { status: "todo", assigneeId: null });
  }

  private async runTaskVerification(
    task: Task,
    location: { absolutePath: string },
    signal: AbortSignal,
  ): Promise<{ verificationOutput: string; verificationExitCode: number }> {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const args =
      process.platform === "win32"
        ? ["/d", "/s", "/c", task.verificationCommand]
        : ["-c", task.verificationCommand];
    try {
      const result = await runCommand(shell, args, {
        cwd: location.absolutePath,
        timeoutMs: AgentDispatcher.VERIFICATION_TIMEOUT_MS,
        maxOutputBytes: AgentDispatcher.VERIFICATION_MAX_OUTPUT_BYTES,
        env: safeProcessEnv(),
        signal,
      });
      const output = this.store
        .redactSecrets([result.stdout, result.stderr].filter(Boolean).join("\n"))
        .slice(0, 4_000);
      return { verificationOutput: output, verificationExitCode: result.exitCode };
    } catch (error) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      return {
        verificationOutput: this.store
          .redactSecrets(error instanceof Error ? error.message : "Verification command failed.")
          .slice(0, 4_000),
        verificationExitCode: 126,
      };
    }
  }

  private async enqueueDelegation<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    const queued = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(agentId, queued);
    try {
      return await result;
    } finally {
      if (this.queues.get(agentId) === queued) this.queues.delete(agentId);
    }
  }

  private updateActivity(run: AgentRun, stage: RunActivity["stage"], detail: string): void {
    const current = this.liveActivities.get(run.id);
    this.liveActivities.set(run.id, {
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      stage,
      thinking: current?.thinking ?? "",
      text: current?.text ?? "",
      detail: this.store.redactSecrets(detail).slice(0, 500),
      updatedAt: new Date().toISOString(),
    });
    this.notifyThread(run.threadId, false);
  }

  private updateActivityThinking(run: AgentRun, value: string, mode: "append" | "replace"): void {
    const current = this.liveActivities.get(run.id);
    const thinking = this.store
      .redactSecrets(mode === "append" ? `${current?.thinking ?? ""}${value}` : value)
      .slice(0, 40_000);
    this.liveActivities.set(run.id, {
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      stage: "thinking",
      thinking,
      text: current?.text ?? "",
      detail: "Reasoning",
      updatedAt: new Date().toISOString(),
    });
    this.notifyThread(run.threadId, false);
  }

  private updateActivityText(run: AgentRun, value: string, mode: "append" | "replace"): void {
    const current = this.liveActivities.get(run.id);
    const text = this.store
      .redactSecrets(mode === "append" ? `${current?.text ?? ""}${value}` : value)
      .slice(0, 40_000);
    this.liveActivities.set(run.id, {
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      stage: "responding",
      thinking: current?.thinking ?? "",
      text,
      detail: "Writing a response",
      updatedAt: new Date().toISOString(),
    });
    this.notifyThread(run.threadId, false);
  }

  private runtimeToolCall(run: AgentRun, update: RuntimeToolUpdate, previous?: ToolCall): ToolCall {
    const now = new Date().toISOString();
    return {
      id: `${run.id}:${update.id}`,
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      name: update.name,
      permission: update.permission,
      status: update.status,
      input: this.store.redactSecrets(update.input).slice(0, 4_000),
      ...(update.summary
        ? { summary: this.store.redactSecrets(update.summary).slice(0, 500) }
        : {}),
      ...(update.error ? { error: this.store.redactSecrets(update.error).slice(0, 2_000) } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private notifyThread(threadId: string, refresh: boolean): void {
    const revision = (this.threadRevisions.get(threadId) ?? 0) + 1;
    this.threadRevisions.set(threadId, revision);
    const event = this.threadStreamSnapshot(threadId, refresh);
    for (const listener of this.threadSubscribers.get(threadId) ?? []) listener(event);
  }

  private isRetryableError(message: string): boolean {
    const transientPatterns = [
      /timeout/i,
      /network/i,
      /connection/i,
      /rate.limit/i,
      /429/i,
      /500/i,
      /502/i,
      /503/i,
      /504/i,
      /temporarily/i,
      /unavailable/i,
      /refused/i,
      /reset/i,
      /aborted/i,
    ];
    return transientPatterns.some((pattern) => pattern.test(message));
  }
}

export class ChatService {
  constructor(
    private readonly store: FileStore,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  async send(
    threadId: string,
    rawInput: unknown,
    uploads: UploadArtifactInput[] = [],
  ): Promise<{ message: Message; runs: AgentRun[] }> {
    const { content } = CreateMessageSchema.parse(rawInput);
    if (!content && uploads.length === 0) {
      throw new StoreError("invalid", "Write a message or attach at least one file.");
    }
    const thread = this.store.getThread(threadId);
    if (!thread) throw new StoreError("not_found", "Thread not found.");
    const agents: Agent[] = [];
    const knowledgeReferences = extractKnowledgeHandles(content).flatMap((handle) => {
      const item = this.store.findKnowledgeByHandle(handle, thread.workspaceId);
      return item ? [{ knowledgeId: item.id, handle: item.handle }] : [];
    });
    const releases: (() => void)[] = [];
    for (const handle of extractMentionHandles(content)) {
      const agent = this.store.findAgentByHandle(handle, thread.workspaceId);
      if (!agent) continue;
      const release = this.dispatcher.reserveAgent(agent.id);
      if (!release) {
        for (const releaseReservedAgent of releases) releaseReservedAgent();
        throw new StoreError(
          "conflict",
          `@${agent.handle} is being updated or deleted. Try again.`,
        );
      }
      agents.push(agent);
      releases.push(release);
    }
    try {
      const mentions = agents.map((agent) => ({ agentId: agent.id, handle: agent.handle }));
      const message = await this.store.createUserMessage(
        threadId,
        content,
        mentions,
        uploads,
        knowledgeReferences,
      );
      const runs = await this.dispatcher.enqueue(message, agents);
      return { message, runs };
    } finally {
      for (const release of releases) release();
    }
  }
}
