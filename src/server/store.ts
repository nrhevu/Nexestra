import { constants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  type Agent,
  type AgentRun,
  AgentSchema,
  CreateAgentSchema,
  CreateTaskSchema,
  CreateThreadSchema,
  CreateWorkspaceSchema,
  type Message,
  MessageSchema,
  RunSchema,
  type Task,
  TaskSchema,
  type Thread,
  type ThreadData,
  ThreadSchema,
  type UpdateAgentInput,
  UpdateAgentSchema,
  UpdateTaskSchema,
  type Workspace,
  WorkspaceSchema,
} from "../shared/contracts.js";

const StateSchema = z.object({
  version: z.literal(2),
  workspaces: z.array(WorkspaceSchema).min(1),
  agents: z.array(AgentSchema),
  threads: z.array(ThreadSchema),
  tasks: z.array(TaskSchema),
});

const LegacyStateSchema = z.object({
  version: z.literal(1),
  agents: z.array(z.record(z.string(), z.unknown())),
  threads: z.array(z.record(z.string(), z.unknown())),
  tasks: z.array(z.record(z.string(), z.unknown())),
});

type PersistedState = z.infer<typeof StateSchema>;

const CredentialSchema = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), z.string()),
});

type TranscriptEvent =
  | { type: "message.created"; sequence: number; message: Message }
  | { type: "run.updated"; sequence: number; run: AgentRun };

interface FileStoreOptions {
  root?: string;
  workspacePath?: string;
}

export class StoreError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export class FileStore {
  readonly root: string;
  readonly workspacePath: string;
  readonly stateFile: string;
  readonly credentialFile: string;
  readonly threadDirectory: string;

  private state: PersistedState;
  private credentials: Record<string, string>;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly sequenceByThread = new Map<string, number>();

  private constructor(
    paths: {
      root: string;
      workspacePath: string;
      stateFile: string;
      credentialFile: string;
      threadDirectory: string;
    },
    state: PersistedState,
    credentials: Record<string, string>,
  ) {
    this.root = paths.root;
    this.workspacePath = paths.workspacePath;
    this.stateFile = paths.stateFile;
    this.credentialFile = paths.credentialFile;
    this.threadDirectory = paths.threadDirectory;
    this.state = state;
    this.credentials = credentials;
  }

  static async open(options: FileStoreOptions = {}): Promise<FileStore> {
    const workspacePath = resolve(options.workspacePath ?? process.cwd());
    const root = resolve(
      options.root ?? process.env.NEXESTRA_HOME ?? join(workspacePath, ".nexestra"),
    );
    const paths = {
      root,
      workspacePath,
      stateFile: join(root, "state.json"),
      credentialFile: join(root, "credentials.json"),
      threadDirectory: join(root, "threads"),
    };
    await mkdir(paths.threadDirectory, { recursive: true, mode: 0o700 });
    const { state, needsWrite } = await readState(paths.stateFile);
    if (needsWrite) await writeJsonAtomic(paths.stateFile, state, 0o600);
    const credentialDocument = await readJson(paths.credentialFile, CredentialSchema, {
      version: 1 as const,
      credentials: {},
    });
    const store = new FileStore(paths, state, { ...credentialDocument.credentials });
    await store.repairTranscriptTails();
    await store.repairThreadSummaries();
    await store.recoverInterruptedRuns();
    return store;
  }

  listWorkspaces(): Workspace[] {
    return structuredClone(this.state.workspaces);
  }

  getWorkspace(id: string): Workspace | undefined {
    const workspace = this.state.workspaces.find((entry) => entry.id === id);
    return workspace ? structuredClone(workspace) : undefined;
  }

  listAgents(workspaceId?: string): Agent[] {
    return structuredClone(
      workspaceId
        ? this.state.agents.filter((agent) => agent.workspaceId === workspaceId)
        : this.state.agents,
    );
  }

  getAgent(id: string): Agent | undefined {
    const agent = this.state.agents.find((entry) => entry.id === id);
    return agent ? structuredClone(agent) : undefined;
  }

  findAgentByHandle(handle: string, workspaceId?: string): Agent | undefined {
    const agent = this.state.agents.find(
      (entry) =>
        entry.handle === handle.toLowerCase() &&
        (workspaceId === undefined || entry.workspaceId === workspaceId),
    );
    return agent ? structuredClone(agent) : undefined;
  }

  listThreads(workspaceId?: string): Thread[] {
    return structuredClone(
      this.state.threads
        .filter((thread) => workspaceId === undefined || thread.workspaceId === workspaceId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }

  getThread(id: string): Thread | undefined {
    const thread = this.state.threads.find((entry) => entry.id === id);
    return thread ? structuredClone(thread) : undefined;
  }

  listTasks(workspaceId?: string): Task[] {
    return structuredClone(
      this.state.tasks
        .filter((task) => workspaceId === undefined || task.workspaceId === workspaceId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }

  getCredential(agentId: string): string | undefined {
    return this.credentials[agentId];
  }

  transcriptPath(threadId: string): string {
    return join(this.threadDirectory, `${threadId}.jsonl`);
  }

  async createWorkspace(rawInput: unknown): Promise<Workspace> {
    const input = CreateWorkspaceSchema.parse(rawInput);
    return this.withWrite(async () => {
      const now = new Date().toISOString();
      const workspace = WorkspaceSchema.parse({
        id: crypto.randomUUID(),
        name: input.name,
        slug: uniqueWorkspaceSlug(input.name, this.state.workspaces),
        createdAt: now,
        updatedAt: now,
      });
      const thread = createThreadRecord(workspace.id, "general", now, []);
      this.state.workspaces.push(workspace);
      this.state.threads.push(thread);
      await this.writeState();
      return structuredClone(workspace);
    });
  }

  async createAgent(rawInput: unknown): Promise<Agent> {
    const input = CreateAgentSchema.parse(rawInput);
    return this.withWrite(async () => {
      const workspaceId = this.requireWorkspace(input.workspaceId).id;
      if (
        this.state.agents.some(
          (agent) => agent.workspaceId === workspaceId && agent.handle === input.handle,
        )
      ) {
        throw new StoreError("conflict", `@${input.handle} is already in use.`);
      }
      const now = new Date().toISOString();
      const base = {
        id: crypto.randomUUID(),
        workspaceId,
        name: input.name,
        handle: input.handle,
        description: input.description,
        instructions: input.instructions,
        enabled: true,
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      let agent: Agent;
      if (input.kind === "worker") {
        agent = {
          ...base,
          kind: "worker",
          harness: input.harness,
          ...(input.model ? { model: input.model } : {}),
          ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        };
      } else if (input.provider.type === "chatgpt") {
        agent = {
          ...base,
          kind: "master",
          provider: { type: "chatgpt", model: input.provider.model },
        };
      } else {
        const credential = input.provider.apiKey?.trim();
        agent = {
          ...base,
          kind: "master",
          provider: {
            type: "custom",
            name: input.provider.name,
            baseUrl: normaliseBaseUrl(input.provider.baseUrl),
            model: input.provider.model,
            protocol: input.provider.protocol,
            hasCredential: Boolean(credential),
          },
        };
        if (credential) {
          this.credentials[agent.id] = credential;
          await this.writeCredentials();
        }
      }
      this.state.agents.push(agent);
      await this.writeState();
      return structuredClone(agent);
    });
  }

  async updateAgent(id: string, rawInput: unknown): Promise<Agent> {
    const input: UpdateAgentInput = UpdateAgentSchema.parse(rawInput);
    return this.withWrite(async () => {
      const index = this.state.agents.findIndex((agent) => agent.id === id);
      const current = this.state.agents[index];
      if (!current) throw new StoreError("not_found", "Agent not found.");
      const updated = AgentSchema.parse({
        ...current,
        ...input,
        enabled: input.archived === true ? false : (input.enabled ?? current.enabled),
        updatedAt: new Date().toISOString(),
      });
      this.state.agents[index] = updated;
      await this.writeState();
      return structuredClone(updated);
    });
  }

  async deleteAgent(id: string): Promise<void> {
    return this.withWrite(async () => {
      const nextState = structuredClone(this.state);
      const index = nextState.agents.findIndex((agent) => agent.id === id);
      if (index === -1) throw new StoreError("not_found", "Agent not found.");

      nextState.agents.splice(index, 1);
      const now = new Date().toISOString();
      for (const task of nextState.tasks) {
        if (task.assigneeId !== id) continue;
        task.assigneeId = null;
        task.updatedAt = now;
      }

      if (Object.hasOwn(this.credentials, id)) {
        const nextCredentials = { ...this.credentials };
        delete nextCredentials[id];
        await this.writeCredentials(nextCredentials);
        this.credentials = nextCredentials;
      }
      await this.writeState(nextState);
      this.state = nextState;
    });
  }

  async createThread(rawInput: unknown): Promise<Thread> {
    const input = CreateThreadSchema.parse(rawInput);
    return this.withWrite(async () => {
      const workspaceId = this.requireWorkspace(input.workspaceId).id;
      const now = new Date().toISOString();
      const thread = createThreadRecord(workspaceId, input.name, now, this.state.threads);
      this.state.threads.push(thread);
      await this.writeState();
      return structuredClone(thread);
    });
  }

  async createUserMessage(
    threadId: string,
    content: string,
    mentions: Message["mentions"],
  ): Promise<Message> {
    return this.appendMessage(threadId, {
      id: crypto.randomUUID(),
      threadId,
      author: { kind: "user", id: "local-user", name: "You" },
      content,
      mentions,
      createdAt: new Date().toISOString(),
    });
  }

  async createAgentMessage(
    threadId: string,
    agent: Agent,
    content: string,
    triggerMessageId: string,
  ): Promise<Message> {
    return this.appendMessage(threadId, {
      id: crypto.randomUUID(),
      threadId,
      author: {
        kind: "agent",
        id: agent.id,
        name: agent.name,
        handle: agent.handle,
      },
      content,
      mentions: [],
      triggerMessageId,
      createdAt: new Date().toISOString(),
    });
  }

  async updateRun(run: AgentRun): Promise<AgentRun> {
    RunSchema.parse(run);
    return this.withWrite(async () => {
      this.requireThread(run.threadId);
      const sequence = await this.nextSequence(run.threadId);
      await appendSynced(this.transcriptPath(run.threadId), {
        type: "run.updated",
        sequence,
        run,
      } satisfies TranscriptEvent);
      this.sequenceByThread.set(run.threadId, sequence);
      return structuredClone(run);
    });
  }

  async threadData(threadId: string): Promise<ThreadData> {
    const thread = this.requireThread(threadId);
    const events = await this.readEvents(threadId);
    const messages: Message[] = [];
    const runs = new Map<string, AgentRun>();
    for (const event of events) {
      if (event.type === "message.created") messages.push(event.message);
      else runs.set(event.run.id, event.run);
    }
    return {
      thread: structuredClone(thread),
      messages: messages.sort((left, right) => left.sequence - right.sequence),
      runs: [...runs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  }

  async transcriptSnapshot(threadId: string): Promise<string> {
    const data = await this.threadData(threadId);
    return data.messages
      .map((message) => {
        const handle = message.author.kind === "agent" ? ` @${message.author.handle}` : "";
        return `[${message.createdAt}] ${message.author.name}${handle}:\n${message.content}`;
      })
      .join("\n\n");
  }

  async createTask(rawInput: unknown): Promise<Task> {
    const input = CreateTaskSchema.parse(rawInput);
    return this.withWrite(async () => {
      const workspaceId = this.requireWorkspace(input.workspaceId).id;
      this.validateReferences(workspaceId, input.assigneeId, input.threadId);
      const now = new Date().toISOString();
      const task = TaskSchema.parse({
        id: crypto.randomUUID(),
        workspaceId,
        title: input.title,
        description: input.description,
        status: input.status,
        assigneeId: input.assigneeId,
        threadId: input.threadId,
        createdAt: now,
        updatedAt: now,
      });
      this.state.tasks.push(task);
      await this.writeState();
      return structuredClone(task);
    });
  }

  async updateTask(id: string, rawInput: unknown): Promise<Task> {
    const input = UpdateTaskSchema.parse(rawInput);
    return this.withWrite(async () => {
      const index = this.state.tasks.findIndex((task) => task.id === id);
      const current = this.state.tasks[index];
      if (!current) throw new StoreError("not_found", "Task not found.");
      const assigneeId = input.assigneeId === undefined ? current.assigneeId : input.assigneeId;
      const threadId = input.threadId === undefined ? current.threadId : input.threadId;
      this.validateReferences(current.workspaceId, assigneeId, threadId);
      const updated = TaskSchema.parse({
        ...current,
        ...input,
        updatedAt: new Date().toISOString(),
      });
      this.state.tasks[index] = updated;
      await this.writeState();
      return structuredClone(updated);
    });
  }

  async activeRuns(workspaceId?: string): Promise<AgentRun[]> {
    const active: AgentRun[] = [];
    for (const thread of this.state.threads.filter(
      (entry) => workspaceId === undefined || entry.workspaceId === workspaceId,
    )) {
      const data = await this.threadData(thread.id);
      active.push(
        ...data.runs.filter((run) => run.status === "queued" || run.status === "running"),
      );
    }
    return active;
  }

  private async appendMessage(
    threadId: string,
    input: Omit<Message, "sequence">,
  ): Promise<Message> {
    return this.withWrite(async () => {
      const thread = this.requireThread(threadId);
      const sequence = await this.nextSequence(threadId);
      const message = MessageSchema.parse({ ...input, sequence });
      await appendSynced(this.transcriptPath(threadId), {
        type: "message.created",
        sequence,
        message,
      } satisfies TranscriptEvent);
      this.sequenceByThread.set(threadId, sequence);
      thread.messageCount += 1;
      thread.lastMessageAt = message.createdAt;
      thread.updatedAt = message.createdAt;
      await this.writeState();
      return structuredClone(message);
    });
  }

  private async nextSequence(threadId: string): Promise<number> {
    const cached = this.sequenceByThread.get(threadId);
    if (cached !== undefined) return cached + 1;
    const events = await this.readEvents(threadId);
    const last = events.at(-1)?.sequence ?? 0;
    this.sequenceByThread.set(threadId, last);
    return last + 1;
  }

  private async readEvents(threadId: string): Promise<TranscriptEvent[]> {
    const file = this.transcriptPath(threadId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const events: TranscriptEvent[] = [];
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const event = parseTranscriptEvent(line);
        if (event) events.push(event);
      } catch (error) {
        const isPartialTail = index === lines.length - 1 && !text.endsWith("\n");
        if (isPartialTail) continue;
        throw new Error(`Transcript ${threadId} is corrupted at line ${index + 1}.`, {
          cause: error,
        });
      }
    }
    return events.sort((left, right) => left.sequence - right.sequence);
  }

  private async repairTranscriptTails(): Promise<void> {
    for (const thread of this.state.threads) {
      await repairTranscriptTail(this.transcriptPath(thread.id));
    }
  }

  private async repairThreadSummaries(): Promise<void> {
    let changed = false;
    for (const thread of this.state.threads) {
      const events = await this.readEvents(thread.id);
      const messages = events.filter((event) => event.type === "message.created");
      const last = messages.at(-1)?.message;
      this.sequenceByThread.set(thread.id, events.at(-1)?.sequence ?? 0);
      if (
        thread.messageCount !== messages.length ||
        thread.lastMessageAt !== (last?.createdAt ?? null)
      ) {
        thread.messageCount = messages.length;
        thread.lastMessageAt = last?.createdAt ?? null;
        if (last) thread.updatedAt = last.createdAt;
        changed = true;
      }
    }
    if (changed || !(await exists(this.stateFile))) await this.writeState();
    if (Object.keys(this.credentials).length > 0) await chmod(this.credentialFile, 0o600);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    for (const thread of this.state.threads) {
      const data = await this.threadData(thread.id);
      for (const run of data.runs) {
        if (run.status !== "queued" && run.status !== "running") continue;
        const hasReply = data.messages.some(
          (message) =>
            message.author.kind === "agent" &&
            message.author.id === run.agentId &&
            message.triggerMessageId === run.triggerMessageId,
        );
        await this.updateRun({
          ...run,
          status: hasReply ? "completed" : "interrupted",
          error: hasReply ? undefined : "The server restarted before the agent replied.",
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private validateReferences(
    workspaceId: string,
    assigneeId: string | null,
    threadId: string | null,
  ): void {
    if (
      assigneeId &&
      !this.state.agents.some(
        (agent) => agent.id === assigneeId && agent.workspaceId === workspaceId && !agent.archived,
      )
    ) {
      throw new StoreError("invalid", "The assigned agent does not exist or has been archived.");
    }
    if (
      threadId &&
      !this.state.threads.some(
        (thread) => thread.id === threadId && thread.workspaceId === workspaceId,
      )
    ) {
      throw new StoreError("invalid", "The linked thread does not exist.");
    }
  }

  private requireWorkspace(id?: string): Workspace {
    const workspace = id
      ? this.state.workspaces.find((entry) => entry.id === id)
      : this.state.workspaces[0];
    if (!workspace) throw new StoreError("not_found", "Workspace not found.");
    return workspace;
  }

  private requireThread(id: string): Thread {
    const thread = this.state.threads.find((entry) => entry.id === id);
    if (!thread) throw new StoreError("not_found", "Thread not found.");
    return thread;
  }

  private async writeState(state = this.state): Promise<void> {
    await writeJsonAtomic(this.stateFile, state, 0o600);
  }

  private async writeCredentials(credentials = this.credentials): Promise<void> {
    await writeJsonAtomic(this.credentialFile, { version: 1, credentials }, 0o600);
  }

  private async withWrite<T>(operation: () => Promise<T>): Promise<T> {
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const previous = this.writeQueue;
    this.writeQueue = previous.then(
      () => next,
      () => next,
    );
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function createInitialState(): PersistedState {
  const now = new Date().toISOString();
  const workspace = WorkspaceSchema.parse({
    id: crypto.randomUUID(),
    name: "Nexestra",
    slug: "nexestra",
    createdAt: now,
    updatedAt: now,
  });
  return {
    version: 2,
    workspaces: [workspace],
    agents: [],
    threads: [createThreadRecord(workspace.id, "general", now, [])],
    tasks: [],
  };
}

function createThreadRecord(
  workspaceId: string,
  name: string,
  now: string,
  threads: Thread[],
): Thread {
  return ThreadSchema.parse({
    id: crypto.randomUUID(),
    workspaceId,
    name,
    slug: uniqueSlug(
      name,
      threads.filter((thread) => thread.workspaceId === workspaceId),
    ),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessageAt: null,
  });
}

function uniqueSlug(name: string, entries: { slug: string }[]): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\u0111/g, "d")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "thread";
  let slug = base;
  let suffix = 2;
  while (entries.some((entry) => entry.slug === slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

function uniqueWorkspaceSlug(name: string, workspaces: Workspace[]): string {
  return uniqueSlug(name, workspaces);
}

function normaliseBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new StoreError("invalid", "Custom providers only support HTTP or HTTPS URLs.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new StoreError(
      "invalid",
      "The base URL must not contain user info, a query string, or a fragment.",
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new StoreError("invalid", "Remote custom providers must use HTTPS.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.startsWith("127.")
  );
}

function parseTranscriptEvent(line: string): TranscriptEvent | undefined {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  const sequence = z.number().int().positive().parse(parsed.sequence);
  if (parsed.type === "message.created") {
    return {
      type: "message.created",
      sequence,
      message: MessageSchema.parse(parsed.message),
    };
  }
  if (parsed.type === "run.updated") {
    return { type: "run.updated", sequence, run: RunSchema.parse(parsed.run) };
  }
  return undefined;
}

async function repairTranscriptTail(file: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (bytes.length === 0 || bytes.at(-1) === 0x0a) return;
  const tailStart = bytes.lastIndexOf(0x0a) + 1;
  const tail = bytes.subarray(tailStart).toString("utf8");
  let tailIsComplete = false;
  try {
    tailIsComplete = Boolean(parseTranscriptEvent(tail));
  } catch {
    // A crash may leave the final write incomplete; only that unsynced tail is discarded.
  }
  const handle = await open(file, "r+");
  try {
    if (tailIsComplete) await handle.write("\n", bytes.length, "utf8");
    else await handle.truncate(tailStart);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendSynced(file: string, event: TranscriptEvent): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(file: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  await rename(temporary, file);
  await chmod(file, mode);
}

async function readJson<T>(file: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return fallback;
    throw new Error(`Unable to read ${file}.`, { cause: error });
  }
}

async function readState(file: string): Promise<{ state: PersistedState; needsWrite: boolean }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { state: createInitialState(), needsWrite: true };
    throw new Error(`Unable to read ${file}.`, { cause: error });
  }

  try {
    const version = z.object({ version: z.number() }).parse(raw).version;
    if (version === 2) return { state: StateSchema.parse(raw), needsWrite: false };
    const legacy = LegacyStateSchema.parse(raw);
    const now = new Date().toISOString();
    const workspace = WorkspaceSchema.parse({
      id: crypto.randomUUID(),
      name: "Nexestra",
      slug: "nexestra",
      createdAt: now,
      updatedAt: now,
    });
    return {
      state: StateSchema.parse({
        version: 2,
        workspaces: [workspace],
        agents: legacy.agents.map((agent) => ({ ...agent, workspaceId: workspace.id })),
        threads: legacy.threads.map((thread) => ({ ...thread, workspaceId: workspace.id })),
        tasks: legacy.tasks.map((task) => ({ ...task, workspaceId: workspace.id })),
      }),
      needsWrite: true,
    };
  } catch (error) {
    throw new Error(`Unable to read ${file}.`, { cause: error });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
