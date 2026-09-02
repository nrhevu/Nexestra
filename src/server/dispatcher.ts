import {
  type Agent,
  type AgentRun,
  CreateMessageSchema,
  extractMentionHandles,
  type Message,
} from "../shared/contracts.js";
import { type AgentInvocation, type AgentRunner, agentView } from "./runtime.js";
import { type FileStore, StoreError } from "./store.js";

export class AgentDispatcher {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly retryingRunIds = new Set<string>();

  constructor(
    private readonly store: FileStore,
    private readonly runner: AgentRunner,
  ) {}

  busyAgentIds(): ReadonlySet<string> {
    return new Set(this.busy);
  }

  async enqueue(trigger: Message, agents: Agent[], attempt = 1): Promise<AgentRun[]> {
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
      await this.store.updateRun(run);
      runs.push(run);
      this.enqueueRun(run, agent, trigger);
    }
    return runs;
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
    try {
      const runtime = await this.runner.runtimeStatus();
      const readiness = agentView(agent, runtime, new Set());
      if (readiness.readiness !== "ready") throw new Error(readiness.readinessLabel);
      await this.store.updateRun({
        ...run,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
      const thread = this.store.getThread(run.threadId);
      if (!thread) throw new StoreError("not_found", "Thread not found.");
      const invocation: AgentInvocation = {
        thread,
        trigger,
        transcriptPath: this.store.transcriptPath(run.threadId),
        transcriptSnapshot: await this.store.transcriptSnapshot(run.threadId),
      };
      const response = (await this.runner.invoke(agent, invocation)).trim();
      if (!response) throw new Error("The agent returned an empty response.");
      await this.store.createAgentMessage(run.threadId, agent, response, trigger.id);
      await this.store.updateRun({
        ...run,
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await this.store.updateRun({
        ...run,
        status: "failed",
        error: error instanceof Error ? error.message : "The agent encountered an unknown error.",
        updatedAt: new Date().toISOString(),
      });
    } finally {
      this.busy.delete(agent.id);
    }
  }
}

export class ChatService {
  constructor(
    private readonly store: FileStore,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  async send(threadId: string, rawInput: unknown): Promise<{ message: Message; runs: AgentRun[] }> {
    const { content } = CreateMessageSchema.parse(rawInput);
    const agents: Agent[] = [];
    for (const handle of extractMentionHandles(content)) {
      const agent = this.store.findAgentByHandle(handle);
      if (agent) agents.push(agent);
    }
    const mentions = agents.map((agent) => ({ agentId: agent.id, handle: agent.handle }));
    const message = await this.store.createUserMessage(threadId, content, mentions);
    const runs = await this.dispatcher.enqueue(message, agents);
    return { message, runs };
  }
}
