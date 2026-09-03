import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  type Agent,
  type AgentRun,
  AgentSchema,
  type Artifact,
  ArtifactSchema,
  CreateAgentSchema,
  CreateKnowledgeDocumentSchema,
  CreateKnowledgeRepositorySchema,
  CreateTaskSchema,
  CreateThreadSchema,
  CreateWorkspaceSchema,
  type KnowledgeItem,
  KnowledgeItemSchema,
  type KnowledgeReference,
  type KnowledgeRepository,
  type Message,
  MessageSchema,
  RunSchema,
  type Task,
  TaskSchema,
  type Thread,
  type ThreadData,
  ThreadSchema,
  type ToolCall,
  ToolCallSchema,
  type UpdateAgentInput,
  UpdateAgentSchema,
  UpdateTaskSchema,
  type WorkAssignment,
  WorkAssignmentSchema,
  type Workspace,
  WorkspaceSchema,
} from "../shared/contracts.js";

const StateSchema = z.object({
  version: z.literal(6),
  workspaces: z.array(WorkspaceSchema).min(1),
  agents: z.array(AgentSchema),
  threads: z.array(ThreadSchema),
  tasks: z.array(TaskSchema),
  knowledge: z.array(KnowledgeItemSchema),
  assignments: z.array(WorkAssignmentSchema),
});

const VersionFiveStateSchema = z.object({
  version: z.literal(5),
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

const VersionTwoStateSchema = z.object({
  version: z.literal(2),
  workspaces: z.array(WorkspaceSchema).min(1),
  agents: z.array(z.record(z.string(), z.unknown())),
  threads: z.array(ThreadSchema),
  tasks: z.array(TaskSchema),
});

const VersionThreeStateSchema = z.object({
  version: z.literal(3),
  workspaces: z.array(WorkspaceSchema).min(1),
  agents: z.array(z.record(z.string(), z.unknown())),
  threads: z.array(ThreadSchema),
  tasks: z.array(TaskSchema),
});

const VersionFourStateSchema = z.object({
  version: z.literal(4),
  workspaces: z.array(WorkspaceSchema).min(1),
  agents: z.array(z.record(z.string(), z.unknown())),
  threads: z.array(ThreadSchema),
  tasks: z.array(TaskSchema),
});

type PersistedState = z.infer<typeof StateSchema>;

const CredentialSchema = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), z.string()),
});

type TranscriptEvent =
  | { type: "message.created"; sequence: number; message: Message }
  | { type: "artifact.created"; sequence: number; artifact: Artifact }
  | { type: "run.updated"; sequence: number; run: AgentRun }
  | { type: "tool.updated"; sequence: number; toolCall: ToolCall };

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;

export interface UploadArtifactInput {
  name: string;
  mediaType?: string;
  bytes: Uint8Array;
}

export interface AgentArtifact {
  artifact: Artifact;
  localPath?: string;
}

export interface AgentKnowledgeItem {
  item: KnowledgeItem;
  localPath: string;
  content?: string;
}

interface ArtifactDraft extends Omit<Artifact, "sequence"> {
  bytes?: Uint8Array;
}

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
  readonly artifactDirectory: string;
  readonly managedWorkspaceDirectory: string;

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
      artifactDirectory: string;
      managedWorkspaceDirectory: string;
    },
    state: PersistedState,
    credentials: Record<string, string>,
  ) {
    this.root = paths.root;
    this.workspacePath = paths.workspacePath;
    this.stateFile = paths.stateFile;
    this.credentialFile = paths.credentialFile;
    this.threadDirectory = paths.threadDirectory;
    this.artifactDirectory = paths.artifactDirectory;
    this.managedWorkspaceDirectory = paths.managedWorkspaceDirectory;
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
      artifactDirectory: join(root, "artifacts"),
      managedWorkspaceDirectory: join(root, "workspaces"),
    };
    await Promise.all([
      mkdir(paths.threadDirectory, { recursive: true, mode: 0o700 }),
      mkdir(paths.artifactDirectory, { recursive: true, mode: 0o700 }),
      mkdir(paths.managedWorkspaceDirectory, { recursive: true, mode: 0o700 }),
    ]);
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

  getTask(id: string): Task | undefined {
    const task = this.state.tasks.find((entry) => entry.id === id);
    return task ? structuredClone(task) : undefined;
  }

  listKnowledge(workspaceId?: string): KnowledgeItem[] {
    return structuredClone(
      this.state.knowledge
        .filter((item) => workspaceId === undefined || item.workspaceId === workspaceId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }

  getKnowledge(id: string): KnowledgeItem | undefined {
    const item = this.state.knowledge.find((entry) => entry.id === id);
    return item ? structuredClone(item) : undefined;
  }

  findKnowledgeByHandle(handle: string, workspaceId: string): KnowledgeItem | undefined {
    const item = this.state.knowledge.find(
      (entry) => entry.workspaceId === workspaceId && entry.handle === handle.toLowerCase(),
    );
    return item ? structuredClone(item) : undefined;
  }

  listAssignments(workspaceId?: string): WorkAssignment[] {
    return structuredClone(
      this.state.assignments
        .filter((assignment) => workspaceId === undefined || assignment.workspaceId === workspaceId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }

  getCredential(agentId: string): string | undefined {
    return this.credentials[agentId];
  }

  redactSecrets(value: string): string {
    let redacted = value;
    for (const credential of Object.values(this.credentials)) {
      if (credential) redacted = redacted.replaceAll(credential, "[REDACTED]");
    }
    return redacted;
  }

  transcriptPath(threadId: string): string {
    return join(this.threadDirectory, `${threadId}.jsonl`);
  }

  async artifactContent(
    threadId: string,
    artifactId: string,
  ): Promise<{ artifact: Artifact; file: string }> {
    const data = await this.threadData(threadId);
    const artifact = data.artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) throw new StoreError("not_found", "Artifact not found.");
    const file = await this.resolveArtifactFile(artifact);
    if (!file) throw new StoreError("invalid", "Link artifacts do not have local content.");
    return { artifact, file };
  }

  async agentArtifacts(threadId: string, messageId: string): Promise<AgentArtifact[]> {
    const data = await this.threadData(threadId);
    return Promise.all(
      data.artifacts
        .filter((artifact) => artifact.messageId === messageId)
        .map(async (artifact) => {
          const localPath =
            artifact.kind === "link"
              ? undefined
              : await this.resolveArtifactFile(artifact).catch(() => undefined);
          return { artifact, ...(localPath ? { localPath } : {}) };
        }),
    );
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

  async createKnowledgeDocument(
    rawInput: unknown,
    upload: UploadArtifactInput,
  ): Promise<KnowledgeItem> {
    const input = CreateKnowledgeDocumentSchema.parse(rawInput);
    validateUploads([upload]);
    return this.withWrite(async () => {
      const workspaceId = this.requireWorkspace(input.workspaceId).id;
      this.requireAvailableKnowledgeHandle(workspaceId, input.handle);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const storagePath = join("workspaces", workspaceId, "knowledge", id, "document");
      const item = KnowledgeItemSchema.parse({
        id,
        workspaceId,
        kind: "document",
        name: input.name,
        handle: input.handle,
        description: input.description,
        fileName: normaliseArtifactName(upload.name),
        mediaType: normaliseMediaType(upload.mediaType) || inferMediaType(upload.name),
        size: upload.bytes.byteLength,
        storagePath,
        createdAt: now,
        updatedAt: now,
      });
      const file = this.managedPath(storagePath);
      await writePrivateFile(file, upload.bytes);
      try {
        this.state.knowledge.push(item);
        await this.writeState();
      } catch (error) {
        this.state.knowledge.pop();
        await unlink(file).catch(() => undefined);
        throw error;
      }
      return structuredClone(item);
    });
  }

  async createKnowledgeRepository(rawInput: unknown): Promise<KnowledgeRepository> {
    const input = CreateKnowledgeRepositorySchema.parse(rawInput);
    return this.withWrite(async () => {
      const workspaceId = this.requireWorkspace(input.workspaceId).id;
      this.requireAvailableKnowledgeHandle(workspaceId, input.handle);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const item = KnowledgeItemSchema.parse({
        id,
        workspaceId,
        kind: "repository",
        name: input.name,
        handle: input.handle,
        description: input.description,
        source: input.source,
        storagePath: join("workspaces", workspaceId, "repositories", id, "source"),
        status: "cloning",
        createdAt: now,
        updatedAt: now,
      });
      if (item.kind !== "repository") throw new Error("Expected repository knowledge.");
      this.state.knowledge.push(item);
      await this.writeState();
      return structuredClone(item);
    });
  }

  async updateKnowledgeRepository(
    id: string,
    update: Pick<KnowledgeRepository, "status"> &
      Partial<Pick<KnowledgeRepository, "defaultBranch" | "error">>,
  ): Promise<KnowledgeRepository> {
    return this.withWrite(async () => {
      const index = this.state.knowledge.findIndex((item) => item.id === id);
      const current = this.state.knowledge[index];
      if (current?.kind !== "repository") {
        throw new StoreError("not_found", "Repository knowledge not found.");
      }
      const next = KnowledgeItemSchema.parse({
        ...current,
        ...update,
        updatedAt: new Date().toISOString(),
      });
      if (next.kind !== "repository") throw new Error("Expected repository knowledge.");
      this.state.knowledge[index] = next;
      await this.writeState();
      return structuredClone(next);
    });
  }

  knowledgePath(item: KnowledgeItem): string {
    return this.managedPath(item.storagePath);
  }

  async agentKnowledge(message: Message): Promise<AgentKnowledgeItem[]> {
    const result: AgentKnowledgeItem[] = [];
    for (const reference of message.knowledgeReferences) {
      const item = this.getKnowledge(reference.knowledgeId);
      if (!item) continue;
      const localPath = this.knowledgePath(item);
      if (item.kind === "document" && isTextMediaType(item.mediaType)) {
        const content = (await readFile(localPath, "utf8")).slice(0, 512 * 1024);
        result.push({ item, localPath, content });
      } else {
        result.push({ item, localPath });
      }
    }
    return result;
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
          accessMode: input.accessMode,
          provider: { type: "chatgpt", model: input.provider.model },
        };
      } else {
        const credential = input.provider.apiKey?.trim();
        agent = {
          ...base,
          kind: "master",
          accessMode: input.accessMode,
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
    uploads: UploadArtifactInput[] = [],
    knowledgeReferences: KnowledgeReference[] = [],
  ): Promise<Message> {
    return this.appendMessage(
      threadId,
      {
        id: crypto.randomUUID(),
        threadId,
        author: { kind: "user", id: "local-user", name: "You" },
        content,
        mentions,
        knowledgeReferences,
        artifactIds: [],
        createdAt: new Date().toISOString(),
      },
      uploads,
    );
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
      knowledgeReferences: [],
      artifactIds: [],
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

  async updateToolCall(toolCall: ToolCall): Promise<ToolCall> {
    ToolCallSchema.parse(toolCall);
    return this.withWrite(async () => {
      this.requireThread(toolCall.threadId);
      const sequence = await this.nextSequence(toolCall.threadId);
      await appendSynced(this.transcriptPath(toolCall.threadId), {
        type: "tool.updated",
        sequence,
        toolCall,
      } satisfies TranscriptEvent);
      this.sequenceByThread.set(toolCall.threadId, sequence);
      return structuredClone(toolCall);
    });
  }

  async threadData(threadId: string): Promise<ThreadData> {
    const thread = this.requireThread(threadId);
    const events = await this.readEvents(threadId);
    const messages: Message[] = [];
    const artifacts: Artifact[] = [];
    const runs = new Map<string, AgentRun>();
    const toolCalls = new Map<string, ToolCall>();
    for (const event of events) {
      if (event.type === "message.created") messages.push(event.message);
      else if (event.type === "artifact.created") artifacts.push(event.artifact);
      else if (event.type === "run.updated") runs.set(event.run.id, event.run);
      else if (event.type === "tool.updated") toolCalls.set(event.toolCall.id, event.toolCall);
    }
    return {
      thread: structuredClone(thread),
      messages: messages.sort((left, right) => left.sequence - right.sequence),
      artifacts: artifacts.sort((left, right) => left.sequence - right.sequence),
      runs: [...runs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      toolCalls: [...toolCalls.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    };
  }

  async transcriptSnapshot(threadId: string): Promise<string> {
    const data = await this.threadData(threadId);
    const artifactsByMessage = new Map<string, Artifact[]>();
    for (const artifact of data.artifacts) {
      const artifacts = artifactsByMessage.get(artifact.messageId) ?? [];
      artifacts.push(artifact);
      artifactsByMessage.set(artifact.messageId, artifacts);
    }
    return data.messages
      .map((message) => {
        const handle = message.author.kind === "agent" ? ` @${message.author.handle}` : "";
        const artifacts = artifactsByMessage.get(message.id) ?? [];
        const artifactText = artifacts.length
          ? `\nArtifacts:\n${artifacts.map(formatArtifactForTranscript).join("\n")}`
          : "";
        const knowledgeText = message.knowledgeReferences.length
          ? `\nKnowledge: ${message.knowledgeReferences.map((reference) => `#${reference.handle}`).join(", ")}`
          : "";
        return `[${message.createdAt}] ${message.author.name}${handle}:\n${message.content}${artifactText}${knowledgeText}`;
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

  async createAssignment(input: WorkAssignment): Promise<WorkAssignment> {
    const assignment = WorkAssignmentSchema.parse(input);
    return this.withWrite(async () => {
      if (this.state.assignments.some((entry) => entry.id === assignment.id)) {
        throw new StoreError("conflict", "Assignment already exists.");
      }
      this.state.assignments.push(assignment);
      await this.writeState();
      return structuredClone(assignment);
    });
  }

  async updateAssignment(
    id: string,
    update: Partial<Pick<WorkAssignment, "status" | "result" | "error">>,
  ): Promise<WorkAssignment> {
    return this.withWrite(async () => {
      const index = this.state.assignments.findIndex((assignment) => assignment.id === id);
      const current = this.state.assignments[index];
      if (!current) throw new StoreError("not_found", "Assignment not found.");
      const next = WorkAssignmentSchema.parse({
        ...current,
        ...update,
        updatedAt: new Date().toISOString(),
      });
      this.state.assignments[index] = next;
      await this.writeState();
      return structuredClone(next);
    });
  }

  private async appendMessage(
    threadId: string,
    input: Omit<Message, "sequence">,
    uploads: UploadArtifactInput[] = [],
  ): Promise<Message> {
    return this.withWrite(async () => {
      const thread = this.requireThread(threadId);
      const artifactDrafts = await this.createArtifactDrafts(input, uploads);
      const messageSequence = await this.nextSequence(threadId);
      const artifacts = artifactDrafts.map((draft, index) =>
        ArtifactSchema.parse({ ...draft, sequence: messageSequence + index + 1 }),
      );
      const message = MessageSchema.parse({
        ...input,
        artifactIds: artifacts.map((artifact) => artifact.id),
        sequence: messageSequence,
      });
      const writtenUploads: string[] = [];
      try {
        for (const draft of artifactDrafts) {
          if (!draft.bytes) continue;
          const file = this.uploadArtifactPath(threadId, draft.id);
          await writePrivateFile(file, draft.bytes);
          writtenUploads.push(file);
        }
        await appendManySynced(this.transcriptPath(threadId), [
          { type: "message.created", sequence: messageSequence, message },
          ...artifacts.map(
            (artifact): TranscriptEvent => ({
              type: "artifact.created",
              sequence: artifact.sequence,
              artifact,
            }),
          ),
        ]);
      } catch (error) {
        await Promise.all(writtenUploads.map((file) => unlink(file).catch(() => undefined)));
        throw error;
      }
      this.sequenceByThread.set(threadId, artifacts.at(-1)?.sequence ?? messageSequence);
      thread.messageCount += 1;
      thread.lastMessageAt = message.createdAt;
      thread.updatedAt = message.createdAt;
      await this.writeState();
      return structuredClone(message);
    });
  }

  private async createArtifactDrafts(
    message: Omit<Message, "sequence">,
    uploads: UploadArtifactInput[],
  ): Promise<ArtifactDraft[]> {
    validateUploads(uploads);
    const drafts: ArtifactDraft[] = uploads.map((upload) => {
      const mediaType = normaliseMediaType(upload.mediaType) || inferMediaType(upload.name);
      return {
        id: crypto.randomUUID(),
        threadId: message.threadId,
        messageId: message.id,
        kind: isSafeImageType(mediaType) ? "image" : "file",
        source: "upload",
        name: normaliseArtifactName(upload.name),
        ...(mediaType ? { mediaType } : {}),
        size: upload.bytes.byteLength,
        createdAt: message.createdAt,
        bytes: upload.bytes,
      };
    });
    const seen = new Set(drafts.map((artifact) => `upload:${artifact.name}:${artifact.size}`));
    for (const reference of await this.discoverReferences(message)) {
      const key = reference.url ? `url:${reference.url}` : `path:${reference.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      drafts.push(reference);
      if (drafts.length >= 40) break;
    }
    return drafts;
  }

  private async discoverReferences(message: Omit<Message, "sequence">): Promise<ArtifactDraft[]> {
    const references: ArtifactDraft[] = [];
    for (const url of extractWebUrls(message.content)) {
      references.push({
        id: crypto.randomUUID(),
        threadId: message.threadId,
        messageId: message.id,
        kind: "link",
        source: "reference",
        name: url,
        url,
        createdAt: message.createdAt,
      });
    }
    for (const candidate of extractFileCandidates(message.content)) {
      const resolved = await this.resolveWorkspaceReference(candidate);
      if (!resolved) continue;
      const mediaType = inferMediaType(resolved.relativePath);
      references.push({
        id: crypto.randomUUID(),
        threadId: message.threadId,
        messageId: message.id,
        kind: isSafeImageType(mediaType) ? "image" : "file",
        source: "reference",
        name: basename(resolved.relativePath),
        ...(mediaType ? { mediaType } : {}),
        size: resolved.size,
        path: resolved.relativePath,
        createdAt: message.createdAt,
      });
    }
    return references;
  }

  private async resolveWorkspaceReference(
    candidate: string,
  ): Promise<{ relativePath: string; size: number } | undefined> {
    const cleaned = cleanFileCandidate(candidate);
    if (!cleaned) return undefined;
    let candidatePath = isAbsolute(cleaned)
      ? resolve(cleaned)
      : resolve(this.workspacePath, cleaned);
    let details = await stat(candidatePath).catch(() => undefined);
    if (!details?.isFile()) {
      const withoutLocation = cleaned.replace(/:\d+(?::\d+)?$/, "");
      if (withoutLocation === cleaned) return undefined;
      candidatePath = isAbsolute(withoutLocation)
        ? resolve(withoutLocation)
        : resolve(this.workspacePath, withoutLocation);
      details = await stat(candidatePath).catch(() => undefined);
    }
    if (!details?.isFile() || details.size > MAX_UPLOAD_BYTES) return undefined;
    const [workspaceRealPath, fileRealPath] = await Promise.all([
      realpath(this.workspacePath),
      realpath(candidatePath),
    ]);
    const relativePath = relative(workspaceRealPath, fileRealPath).replaceAll("\\", "/");
    if (
      !relativePath ||
      relativePath === "." ||
      relativePath.startsWith("../") ||
      isAbsolute(relativePath) ||
      /^(?:\.git|\.nexestra)(?:\/|$)/.test(relativePath)
    ) {
      return undefined;
    }
    return { relativePath, size: details.size };
  }

  private async resolveArtifactFile(artifact: Artifact): Promise<string | undefined> {
    if (artifact.kind === "link") return undefined;
    if (artifact.source === "upload") {
      const file = this.uploadArtifactPath(artifact.threadId, artifact.id);
      const details = await stat(file).catch(() => undefined);
      if (!details?.isFile()) throw new StoreError("not_found", "Artifact content not found.");
      return file;
    }
    if (!artifact.path) throw new StoreError("invalid", "Artifact path is missing.");
    const resolved = await this.resolveWorkspaceReference(artifact.path);
    if (!resolved) throw new StoreError("not_found", "Referenced file is no longer available.");
    return resolve(this.workspacePath, resolved.relativePath);
  }

  private uploadArtifactPath(threadId: string, artifactId: string): string {
    if (!isStorageId(threadId) || !isStorageId(artifactId)) {
      throw new StoreError("invalid", "Invalid artifact storage identifier.");
    }
    return join(this.artifactDirectory, threadId, artifactId);
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
        if (
          run.status !== "queued" &&
          run.status !== "running" &&
          run.status !== "waiting_approval" &&
          run.status !== "waiting_input"
        ) {
          continue;
        }
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
      for (const toolCall of data.toolCalls) {
        if (
          toolCall.status !== "running" &&
          toolCall.status !== "waiting_approval" &&
          toolCall.status !== "waiting_input"
        ) {
          continue;
        }
        await this.updateToolCall({
          ...toolCall,
          status: "interrupted",
          error: "The server restarted before this tool call finished.",
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

  private requireAvailableKnowledgeHandle(workspaceId: string, handle: string): void {
    if (
      this.state.knowledge.some(
        (item) => item.workspaceId === workspaceId && item.handle === handle,
      )
    ) {
      throw new StoreError("conflict", `#${handle} is already used in this workspace.`);
    }
  }

  private managedPath(storagePath: string): string {
    const target = resolve(this.root, storagePath);
    const offset = relative(this.root, target);
    if (!offset || offset.startsWith("..") || isAbsolute(offset)) {
      throw new StoreError("invalid", "Managed path must stay inside the Nexestra data root.");
    }
    return target;
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
    version: 6,
    workspaces: [workspace],
    agents: [],
    threads: [createThreadRecord(workspace.id, "general", now, [])],
    tasks: [],
    knowledge: [],
    assignments: [],
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

const SAFE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const MEDIA_TYPES_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function validateUploads(uploads: UploadArtifactInput[]): void {
  if (uploads.length > MAX_UPLOAD_FILES) {
    throw new StoreError("invalid", `Attach no more than ${MAX_UPLOAD_FILES} files at once.`);
  }
  let total = 0;
  for (const upload of uploads) {
    if (!(upload.bytes instanceof Uint8Array)) {
      throw new StoreError("invalid", "An attachment could not be read.");
    }
    if (upload.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new StoreError("invalid", "Each attachment must be 20 MB or smaller.");
    }
    normaliseArtifactName(upload.name);
    total += upload.bytes.byteLength;
  }
  if (total > MAX_UPLOAD_TOTAL_BYTES) {
    throw new StoreError("invalid", "Attachments must be 50 MB or smaller in total.");
  }
}

function normaliseArtifactName(value: string): string {
  const rawName = value.split(/[\\/]/).at(-1) ?? "";
  const name = [...rawName]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  if (!name) throw new StoreError("invalid", "Every attachment needs a file name.");
  return name.slice(0, 255);
}

function normaliseMediaType(value?: string): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase().slice(0, 160) ?? "";
}

function inferMediaType(name: string): string {
  return MEDIA_TYPES_BY_EXTENSION[extname(name).toLowerCase()] ?? "";
}

function isSafeImageType(mediaType: string): boolean {
  return SAFE_IMAGE_TYPES.has(mediaType);
}

function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    ["application/json", "application/yaml", "application/xml"].includes(mediaType)
  );
}

function extractWebUrls(content: string): string[] {
  const urls = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const candidate = match[0].replace(/[),.;!?\]}]+$/, "");
    try {
      const url = new URL(candidate);
      if (url.protocol === "http:" || url.protocol === "https:") urls.add(url.toString());
    } catch {
      // A malformed URL remains ordinary message text.
    }
  }
  return [...urls];
}

function extractFileCandidates(content: string): string[] {
  const candidates = new Set<string>();
  for (const match of content.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    if (match[1]) candidates.add(match[1]);
  }
  for (const match of content.matchAll(/`([^`\n]+)`/g)) {
    if (match[1]) candidates.add(match[1]);
  }
  return [...candidates];
}

function cleanFileCandidate(value: string): string | undefined {
  let candidate = value.trim().replace(/^<|>$/g, "");
  if (!candidate || /^(?:https?:|data:|#)/i.test(candidate) || candidate.includes("\0")) {
    return undefined;
  }
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return undefined;
  }
  candidate = candidate.replace(/#L\d+(?:-L\d+)?$/, "");
  if (
    !candidate.includes("/") &&
    !candidate.includes("\\") &&
    !/\.[a-zA-Z0-9]{1,12}(?::\d+(?::\d+)?)?$/.test(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

function formatArtifactForTranscript(artifact: Artifact): string {
  const target = artifact.url ?? artifact.path;
  return `- [${artifact.kind}] ${artifact.name}${target ? ` (${target})` : ""}`;
}

function isStorageId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,200}$/.test(value);
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
  if (parsed.type === "artifact.created") {
    return {
      type: "artifact.created",
      sequence,
      artifact: ArtifactSchema.parse(parsed.artifact),
    };
  }
  if (parsed.type === "run.updated") {
    return { type: "run.updated", sequence, run: RunSchema.parse(parsed.run) };
  }
  if (parsed.type === "tool.updated") {
    return {
      type: "tool.updated",
      sequence,
      toolCall: ToolCallSchema.parse(parsed.toolCall),
    };
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
  await appendManySynced(file, [event]);
}

async function appendManySynced(file: string, events: TranscriptEvent[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "a", 0o600);
  try {
    await handle.appendFile(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(file: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
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
    if (version === 6) return { state: StateSchema.parse(raw), needsWrite: false };
    if (version === 5) {
      const previous = VersionFiveStateSchema.parse(raw);
      return {
        state: StateSchema.parse({
          ...previous,
          version: 6,
          knowledge: [],
          assignments: [],
        }),
        needsWrite: true,
      };
    }
    if (version === 4) {
      const previous = VersionFourStateSchema.parse(raw);
      return {
        state: StateSchema.parse({
          ...previous,
          version: 6,
          agents: previous.agents.map(migrateMasterAccessMode),
          knowledge: [],
          assignments: [],
        }),
        needsWrite: true,
      };
    }
    if (version === 3) {
      const previous = VersionThreeStateSchema.parse(raw);
      return {
        state: StateSchema.parse({
          ...previous,
          version: 6,
          agents: previous.agents.map(migrateMasterAccessMode),
          knowledge: [],
          assignments: [],
        }),
        needsWrite: true,
      };
    }
    if (version === 2) {
      const previous = VersionTwoStateSchema.parse(raw);
      return {
        state: StateSchema.parse({
          ...previous,
          version: 6,
          agents: previous.agents.map(migrateMasterAccessMode),
          knowledge: [],
          assignments: [],
        }),
        needsWrite: true,
      };
    }
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
        version: 6,
        workspaces: [workspace],
        agents: legacy.agents.map((agent) =>
          migrateMasterAccessMode({ ...agent, workspaceId: workspace.id }),
        ),
        threads: legacy.threads.map((thread) => ({ ...thread, workspaceId: workspace.id })),
        tasks: legacy.tasks.map((task) => ({ ...task, workspaceId: workspace.id })),
        knowledge: [],
        assignments: [],
      }),
      needsWrite: true,
    };
  } catch (error) {
    throw new Error(`Unable to read ${file}.`, { cause: error });
  }
}

function migrateMasterAccessMode(agent: Record<string, unknown>): Record<string, unknown> {
  if (agent.kind !== "master") return agent;
  const { permissions: rawPermissions, ...rest } = agent;
  const permissions = isRecord(rawPermissions) ? rawPermissions : {};
  const currentKeys = [
    "read",
    "edit",
    "bash",
    "skill",
    "todowrite",
    "webfetch",
    "websearch",
    "question",
    "external",
  ];
  const allCurrentToolsAllowed = currentKeys.every((key) => permissions[key] === "allow");
  const codingToolsAllowed = permissions.edit === "allow" && permissions.bash === "allow";
  return {
    ...rest,
    accessMode: allCurrentToolsAllowed ? "full" : codingToolsAllowed ? "auto" : "ask",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
