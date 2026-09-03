import {
  type Agent,
  type AgentRun,
  CreateMessageSchema,
  extractMentionHandles,
  type Message,
} from "../shared/contracts.js";
import { type AgentInvocation, type AgentRunner, agentView } from "./runtime.js";
import { type FileStore, StoreError, type UploadArtifactInput } from "./store.js";

export class AgentDispatcher {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly pendingEnqueues = new Map<string, number>();
  private readonly deletingAgentIds = new Set<string>();
  private readonly retryingRunIds = new Set<string>();
  private readonly liveRuns = new Map<string, AgentRun>();
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

  hasPendingWork(agentId: string): boolean {
    return this.queues.has(agentId) || (this.pendingEnqueues.get(agentId) ?? 0) > 0;
  }

  beginAgentDeletion(agentId: string): boolean {
    if (this.deletingAgentIds.has(agentId) || this.hasPendingWork(agentId)) return false;
    this.deletingAgentIds.add(agentId);
    return true;
  }

  finishAgentDeletion(agentId: string): void {
    this.deletingAgentIds.delete(agentId);
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
    if (this.deletingAgentIds.has(agentId)) return undefined;
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
        throw new StoreError("conflict", `@${agent.handle} is being deleted.`);
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
    while (this.queues.size > 0) {
      await Promise.all([...this.queues.values()]);
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
      const thread = this.store.getThread(run.threadId);
      if (!thread) throw new StoreError("not_found", "Thread not found.");
      const [transcriptSnapshot, artifacts] = await Promise.all([
        this.store.transcriptSnapshot(run.threadId),
        this.store.agentArtifacts(run.threadId, trigger.id),
      ]);
      const invocation: AgentInvocation = {
        runId: run.id,
        thread,
        trigger,
        transcriptPath: this.store.transcriptPath(run.threadId),
        transcriptSnapshot,
        artifacts,
        toolHooks: {
          update: (toolCall) => this.store.updateToolCall(toolCall).then(() => undefined),
          requestApproval: async (toolCall) => {
            const decision = new Promise<boolean>((resolve) => {
              this.pendingApprovals.set(toolCall.id, { runId: run.id, resolve });
            });
            try {
              await this.store.updateToolCall(toolCall);
              currentRun = await this.store.updateRun({
                ...currentRun,
                status: "waiting_approval",
                updatedAt: new Date().toISOString(),
              });
              this.liveRuns.set(currentRun.id, currentRun);
              return await decision;
            } finally {
              this.pendingApprovals.delete(toolCall.id);
              currentRun = await this.store.updateRun({
                ...currentRun,
                status: "running",
                updatedAt: new Date().toISOString(),
              });
              this.liveRuns.set(currentRun.id, currentRun);
            }
          },
          requestInput: async (toolCall) => {
            const response = new Promise<string[][]>((resolve) => {
              this.pendingInputs.set(toolCall.id, { runId: run.id, resolve });
            });
            try {
              await this.store.updateToolCall(toolCall);
              currentRun = await this.store.updateRun({
                ...currentRun,
                status: "waiting_input",
                updatedAt: new Date().toISOString(),
              });
              this.liveRuns.set(currentRun.id, currentRun);
              return await response;
            } finally {
              this.pendingInputs.delete(toolCall.id);
              currentRun = await this.store.updateRun({
                ...currentRun,
                status: "running",
                updatedAt: new Date().toISOString(),
              });
              this.liveRuns.set(currentRun.id, currentRun);
            }
          },
        },
      };
      const response = (await this.runner.invoke(agent, invocation)).trim();
      if (!response) throw new Error("The agent returned an empty response.");
      await this.store.createAgentMessage(run.threadId, agent, response, trigger.id);
      await this.store.updateRun({
        ...currentRun,
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.store.updateRun({
        ...currentRun,
        status: "failed",
        error: this.store.redactSecrets(
          error instanceof Error ? error.message : "The agent encountered an unknown error.",
        ),
        updatedAt: new Date().toISOString(),
      });
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
      this.busy.delete(agent.id);
    }
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
    const releases: (() => void)[] = [];
    for (const handle of extractMentionHandles(content)) {
      const agent = this.store.findAgentByHandle(handle, thread.workspaceId);
      if (!agent) continue;
      const release = this.dispatcher.reserveAgent(agent.id);
      if (!release) continue;
      agents.push(agent);
      releases.push(release);
    }
    try {
      const mentions = agents.map((agent) => ({ agentId: agent.id, handle: agent.handle }));
      const message = await this.store.createUserMessage(threadId, content, mentions, uploads);
      const runs = await this.dispatcher.enqueue(message, agents);
      return { message, runs };
    } finally {
      for (const release of releases) release();
    }
  }
}
