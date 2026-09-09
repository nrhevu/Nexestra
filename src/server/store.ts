import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
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
  type KnowledgeDocument,
  type KnowledgeDocumentPreview,
  KnowledgeDocumentPreviewSchema,
  type KnowledgeDocumentRevisions,
  KnowledgeDocumentSchema,
  type KnowledgeItem,
  KnowledgeItemSchema,
  type KnowledgeReference,
  type KnowledgeRepository,
  MESSAGE_SEARCH_MAX_OFFSET,
  MESSAGE_SEARCH_QUERY_MAX_LENGTH,
  MESSAGE_SEARCH_SNIPPET_MAX_CHARS,
  type Message,
  MessageRequestIdSchema,
  MessageSchema,
  type MessageSearchAuthor,
  MessageSearchAuthorSchema,
  type MessageSearchDiagnostics,
  type MessageSearchHit,
  MessageSearchHitSchema,
  type MessageSearchRequest,
  MessageSearchRequestSchema,
  type MessageSearchResponse,
  MessageSearchResponseSchema,
  RenameThreadSchema,
  ReorderWorkspacesSchema,
  ReplaceKnowledgeDocumentSchema,
  RestoreKnowledgeDocumentRevisionSchema,
  type RunHistoryItem,
  type RunHistoryPage,
  RunHistoryPageSchema,
  RunHistoryRequestSchema,
  RunSchema,
  type Task,
  TaskSchema,
  type Thread,
  type ThreadData,
  type ThreadHistoryPage,
  ThreadHistoryPageSchema,
  type ThreadHistoryRequest,
  ThreadSchema,
  type ToolCall,
  ToolCallSchema,
  type UpdateAgentInput,
  UpdateAgentSchema,
  UpdateKnowledgeSchema,
  UpdateTaskSchema,
  UpdateWorkspaceSchema,
  type WorkAssignment,
  WorkAssignmentSchema,
  type Workspace,
  WorkspaceSchema,
} from "../shared/contracts.js";

import {
  addTranscriptHistoryEntry,
  emptyTranscriptHistoryIndex,
  HISTORY_MAX_EVENT_BYTES,
  HISTORY_MAX_PAGE_BYTES,
  type HistoryAnchorMode,
  planHistoryPage,
  planHistoryPageAt,
  type RawTranscriptEvent,
  type RunHistorySummary,
  readTranscriptPageLines,
  scanTranscriptHistoryFile,
  setRunHistorySummary,
  type TranscriptHistoryIndex,
  transcriptFileIdentityOf,
  transcriptHistoryEntry,
} from "./conversation-history.js";

import {
  compareRunHistorySummaries,
  decodeRunHistoryCursor,
  encodeRunHistoryCursor,
  type RunHistoryCursorPayload,
  runHistorySummaryAfterCursor,
} from "./run-history.js";

const StateSchema = z.object({
  version: z.literal(7),
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

const VersionSixStateSchema = z.object({
  version: z.literal(6),
  workspaces: z.array(WorkspaceSchema).min(1),
  agents: z.array(AgentSchema),
  threads: z.array(ThreadSchema),
  tasks: z.array(z.record(z.string(), z.unknown())),
  knowledge: z.array(KnowledgeItemSchema),
  assignments: z.array(z.record(z.string(), z.unknown())),
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

type DocumentRevision = KnowledgeDocument["revisions"][number];

const CredentialSchema = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), z.string()),
});

type TranscriptEvent =
  | {
      type: "message.created";
      sequence: number;
      message: Message;
      submission?: UserSubmissionEnvelope;
    }
  | { type: "artifact.created"; sequence: number; artifact: Artifact }
  | { type: "run.updated"; sequence: number; run: AgentRun }
  | { type: "tool.updated"; sequence: number; toolCall: ToolCall };

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;

export interface MessageSearchBudgets {
  maxScanBytes: number;
  maxScanLines: number;
  maxLineBytes: number;
}

export const MESSAGE_SEARCH_DEFAULT_BUDGETS: MessageSearchBudgets = {
  maxScanBytes: 50 * 1024 * 1024,
  maxScanLines: 200_000,
  maxLineBytes: 1 * 1024 * 1024,
};
export const PREVIEW_BUDGET_BYTES = 128 * 1024;
export const MAX_CREDENTIAL_UTF8_BYTES = 4_096 * 4;
export const PREVIEW_OVERREAD_BYTES = 4;
export const MAX_PREVIEW_REDACTION_LOOKAHEAD_BYTES =
  MAX_CREDENTIAL_UTF8_BYTES + PREVIEW_OVERREAD_BYTES;

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

interface UserSubmissionArtifactPlanEntry {
  id: string;
  kind: "image" | "file" | "link";
  source: "upload" | "reference";
  name: string;
  mediaType?: string;
  size?: number;
  url?: string;
  path?: string;
  createdAt: string;
}

interface UserSubmissionEnvelope {
  requestIdHash: string;
  fingerprint: string;
  artifactPlan?: UserSubmissionArtifactPlanEntry[];
}

interface UserSubmissionReceipt {
  requestIdHash: string;
  fingerprint: string;
  messageId: string;
  sequence: number;
  lineStart: number;
  lineEnd: number;
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
  private readonly historyIndexes = new Map<string, TranscriptHistoryIndex>();
  private readonly submissionReceipts = new Map<string, UserSubmissionReceipt>();
  private readonly dirtyMetadataThreads = new Set<string>();
  private readonly uncertainDurabilityThreads = new Set<string>();

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
    await store.primeTranscriptIndexes();
    await store.repairThreadSummaries();
    await store.recoverInterruptedRuns();
    await store.recoverInterruptedRepositories();
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
      if (!credential) continue;
      if (credential.length >= 8) {
        redacted = redacted.replaceAll(credential, "[REDACTED]");
        continue;
      }
      const escaped = credential.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const token = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "gu");
      redacted = redacted.replace(token, (_match, prefix: string) => `${prefix}[REDACTED]`);
    }
    return redacted;
  }

  redactPreviewText(previewText: string, lookaheadText: string): string {
    const credentials = Object.values(this.credentials).filter((value) => value.length > 0);
    if (credentials.length === 0) return this.redactSecrets(previewText);
    const boundaryChars = previewText.length;
    let earliestCut: number | undefined;
    for (const credential of credentials) {
      let fromIndex = 0;
      for (;;) {
        const start = lookaheadText.indexOf(credential, fromIndex);
        if (start === -1) break;
        const end = start + credential.length;
        if (start < boundaryChars && end > boundaryChars) {
          earliestCut = earliestCut === undefined ? start : Math.min(earliestCut, start);
        }
        fromIndex = start + 1;
      }
    }
    if (earliestCut !== undefined) {
      return this.redactSecrets(lookaheadText.slice(0, earliestCut));
    }
    return this.redactSecrets(previewText);
  }

  transcriptPath(threadId: string): string {
    return join(this.threadDirectory, `${threadId}.jsonl`);
  }
  async searchMessages(
    rawInput: unknown,
    budgets: Partial<MessageSearchBudgets> = {},
  ): Promise<MessageSearchResponse> {
    const input = MessageSearchRequestSchema.parse(rawInput);
    const workspace = this.getWorkspace(input.workspaceId);
    if (!workspace) throw new StoreError("not_found", "Workspace not found.");
    let threads = this.listThreads(input.workspaceId).sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
    if (input.threadId) {
      const thread = threads.find((entry) => entry.id === input.threadId);
      if (!thread) {
        throw new StoreError("not_found", "Thread not found in this workspace.");
      }
      threads = [thread];
    }
    threads = threads.filter((thread) =>
      input.archived === "all" ? true : thread.archived === (input.archived === "archived"),
    );
    const mergedBudgets = { ...MESSAGE_SEARCH_DEFAULT_BUDGETS, ...budgets };
    const scanner = new MessageSearchScanner(this, input, mergedBudgets);
    for (const thread of threads) {
      await scanner.scanThread(thread);
      if (scanner.isScanLimited()) break;
    }
    return scanner.response(input);
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
      const next = {
        ...this.state,
        workspaces: [...this.state.workspaces, workspace],
        threads: [...this.state.threads, thread],
      };
      await this.writeState(next);
      this.state = next;
      return structuredClone(workspace);
    });
  }

  async updateWorkspace(id: string, rawInput: unknown): Promise<Workspace> {
    const input = UpdateWorkspaceSchema.parse(rawInput);
    return this.withWrite(async () => {
      const current = this.requireWorkspace(id);
      if (current.name === input.name) return structuredClone(current);
      const workspace: Workspace = {
        ...current,
        name: input.name,
        slug: uniqueWorkspaceSlug(
          input.name,
          this.state.workspaces.filter((entry) => entry.id !== id),
        ),
        updatedAt: new Date().toISOString(),
      };
      const next = {
        ...this.state,
        workspaces: this.state.workspaces.map((entry) => (entry.id === id ? workspace : entry)),
      };
      await this.writeState(next);
      this.state = next;
      return structuredClone(workspace);
    });
  }

  async reorderWorkspaces(rawInput: unknown): Promise<Workspace[]> {
    const { workspaceIds } = ReorderWorkspacesSchema.parse(rawInput);
    return this.withWrite(async () => {
      const byId = new Map(this.state.workspaces.map((workspace) => [workspace.id, workspace]));
      if (workspaceIds.length !== byId.size || workspaceIds.some((id) => !byId.has(id))) {
        throw new StoreError(
          "conflict",
          "Workspace list changed. Reload the workspace list and try again.",
        );
      }
      const next = {
        ...this.state,
        workspaces: workspaceIds.map((id) => this.requireWorkspace(id)),
      };
      await this.writeState(next);
      this.state = next;
      return this.listWorkspaces();
    });
  }

  async createKnowledgeDocument(
    rawInput: unknown,
    upload: UploadArtifactInput,
  ): Promise<KnowledgeDocument> {
    const input = CreateKnowledgeDocumentSchema.parse(rawInput);
    validateUploads([upload]);
    return this.withWrite(async () => {
      const workspaceId = this.requireWorkspace(input.workspaceId).id;
      this.requireAvailableKnowledgeHandle(workspaceId, input.handle);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const revisionId = crypto.randomUUID();
      const storagePath = join("workspaces", workspaceId, "knowledge", id, "revisions", revisionId);
      const item = KnowledgeDocumentSchema.parse({
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
        revisions: [
          {
            id: revisionId,
            createdAt: now,
            fileName: normaliseArtifactName(upload.name),
            mediaType: normaliseMediaType(upload.mediaType) || inferMediaType(upload.name),
            size: upload.bytes.byteLength,
            storagePath,
            sha256: hashBytes(upload.bytes),
          },
        ],
        currentRevisionId: revisionId,
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

  async replaceKnowledgeDocument(
    id: string,
    rawInput: unknown,
    upload: UploadArtifactInput,
  ): Promise<KnowledgeItem> {
    const input = ReplaceKnowledgeDocumentSchema.parse(rawInput);
    validateUploads([upload]);
    return this.withWrite(async () => {
      const index = this.state.knowledge.findIndex((item) => item.id === id);
      const current = this.state.knowledge[index];
      if (current?.kind !== "document") {
        throw new StoreError("not_found", "Knowledge document not found.");
      }
      this.requireExpectedDocumentRevision(current, input.expectedRevisionId);
      const now = new Date().toISOString();
      const nextState = structuredClone(this.state);
      const createdPaths: string[] = [];
      let baseDocument = nextState.knowledge[index];
      if (baseDocument?.kind !== "document") {
        throw new StoreError("not_found", "Knowledge document not found.");
      }
      if (baseDocument.revisions.length === 0) {
        baseDocument = await this.captureLegacyDocumentRevision(
          nextState,
          index,
          now,
          createdPaths,
        );
      }
      const uploadRevision = this.newDocumentRevision(
        baseDocument.workspaceId,
        baseDocument.id,
        {
          name: upload.name,
          mediaType: upload.mediaType,
          bytes: upload.bytes,
        },
        now,
      );
      await writePrivateFile(this.managedPath(uploadRevision.storagePath), upload.bytes);
      const updated = KnowledgeDocumentSchema.parse({
        ...baseDocument,
        fileName: uploadRevision.fileName,
        mediaType: uploadRevision.mediaType,
        size: uploadRevision.size,
        storagePath: uploadRevision.storagePath,
        revisions: [...baseDocument.revisions, uploadRevision],
        currentRevisionId: uploadRevision.id,
        updatedAt: now,
      });
      try {
        nextState.knowledge[index] = updated;
        await this.writeState(nextState);
      } catch (error) {
        await unlink(this.managedPath(uploadRevision.storagePath)).catch(() => undefined);
        for (const created of createdPaths) {
          await unlink(created).catch(() => undefined);
        }
        throw error;
      }
      this.state = nextState;
      return structuredClone(updated);
    });
  }

  async restoreKnowledgeDocumentRevision(
    id: string,
    revisionId: string,
    rawInput: unknown,
  ): Promise<KnowledgeItem> {
    const input = RestoreKnowledgeDocumentRevisionSchema.parse(rawInput);
    return this.withWrite(async () => {
      const index = this.state.knowledge.findIndex((item) => item.id === id);
      const current = this.state.knowledge[index];
      if (current?.kind !== "document") {
        throw new StoreError("not_found", "Knowledge document not found.");
      }
      this.requireExpectedDocumentRevision(current, input.expectedRevisionId);
      const nextState = structuredClone(this.state);
      const nextItem = nextState.knowledge[index];
      if (nextItem?.kind !== "document") {
        throw new StoreError("not_found", "Knowledge document not found.");
      }
      const source = nextItem.revisions.find((revision) => revision.id === revisionId);
      if (!source) {
        throw new StoreError("not_found", "Document revision not found.");
      }
      const sourceFile = this.managedPath(source.storagePath);
      const bytes = await readFile(sourceFile);
      if (hashBytes(bytes) !== source.sha256) {
        throw new StoreError("invalid", "Document revision content is corrupted.");
      }
      const now = new Date().toISOString();
      const restored = this.newDocumentRevision(
        nextItem.workspaceId,
        nextItem.id,
        {
          name: source.fileName,
          mediaType: source.mediaType,
          bytes,
        },
        now,
        source.id,
      );
      await writePrivateFile(this.managedPath(restored.storagePath), bytes);
      const updated = KnowledgeDocumentSchema.parse({
        ...nextItem,
        fileName: restored.fileName,
        mediaType: restored.mediaType,
        size: restored.size,
        storagePath: restored.storagePath,
        revisions: [...nextItem.revisions, restored],
        currentRevisionId: restored.id,
        updatedAt: now,
      });
      try {
        nextState.knowledge[index] = updated;
        await this.writeState(nextState);
      } catch (error) {
        await unlink(this.managedPath(restored.storagePath)).catch(() => undefined);
        throw error;
      }
      this.state = nextState;
      return structuredClone(updated);
    });
  }

  async listKnowledgeDocumentRevisions(id: string): Promise<KnowledgeDocumentRevisions> {
    const item = this.getKnowledge(id);
    if (item?.kind !== "document") {
      throw new StoreError("not_found", "Knowledge document not found.");
    }
    return {
      currentRevisionId: item.currentRevisionId,
      revisions: structuredClone([...item.revisions].reverse()),
    };
  }

  async documentRevisionContent(
    id: string,
    revisionId: string,
  ): Promise<{ revision: DocumentRevision; bytes: Uint8Array<ArrayBuffer> }> {
    const item = this.getKnowledge(id);
    if (item?.kind !== "document") {
      throw new StoreError("not_found", "Knowledge document not found.");
    }
    const revision = item.revisions.find((entry) => entry.id === revisionId);
    if (!revision) {
      throw new StoreError("not_found", "Document revision not found.");
    }
    const bytes = await readFile(this.managedPath(revision.storagePath));
    if (hashBytes(bytes) !== revision.sha256) {
      throw new StoreError("invalid", "Document revision content is corrupted.");
    }
    return { revision: structuredClone(revision), bytes: Uint8Array.from(bytes) };
  }

  async previewKnowledgeDocument(
    id: string,
    revisionId?: string,
  ): Promise<KnowledgeDocumentPreview> {
    const item = this.getKnowledge(id);
    if (item?.kind !== "document") {
      throw new StoreError("not_found", "Knowledge document not found.");
    }
    const revision = revisionId
      ? item.revisions.find((entry) => entry.id === revisionId)
      : item.currentRevisionId
        ? item.revisions.find((entry) => entry.id === item.currentRevisionId)
        : undefined;
    if (revisionId && !revision) {
      throw new StoreError("not_found", "Document revision not found.");
    }
    if (!revisionId && item.currentRevisionId && !revision) {
      throw new StoreError("invalid", "Document revision content is corrupted.");
    }
    const isCurrent = revisionId === undefined || revision?.id === item.currentRevisionId;
    const base = revision
      ? {
          revisionId: revision.id,
          fileName: this.redactSecrets(revision.fileName),
          mediaType: this.redactSecrets(revision.mediaType),
          size: revision.size,
          sha256: revision.sha256,
          createdAt: revision.createdAt,
        }
      : {
          fileName: this.redactSecrets(item.fileName),
          mediaType: this.redactSecrets(item.mediaType),
          size: item.size,
        };
    if (
      Object.values(this.credentials).some(
        (value) => Buffer.byteLength(value) > MAX_PREVIEW_REDACTION_LOOKAHEAD_BYTES,
      )
    ) {
      return KnowledgeDocumentPreviewSchema.parse({
        ...base,
        isCurrent,
        supported: false,
        truncated: false,
        reason:
          "Preview is unavailable because a stored credential exceeds the redaction lookahead bound. Download this version instead.",
      });
    }
    if (!isTextMediaType(base.mediaType)) {
      return KnowledgeDocumentPreviewSchema.parse({
        ...base,
        isCurrent,
        supported: false,
        truncated: false,
        reason: "This file type cannot be previewed as plain text. Download it instead.",
      });
    }
    const file = revision ? this.managedPath(revision.storagePath) : this.knowledgePath(item);
    const redactionLookaheadBytes = Math.min(
      MAX_PREVIEW_REDACTION_LOOKAHEAD_BYTES,
      Math.max(
        PREVIEW_OVERREAD_BYTES,
        ...Object.values(this.credentials).map((value) => Buffer.byteLength(value)),
      ),
    );
    let streamed: Awaited<ReturnType<typeof hashAndBoundPreview>>;
    try {
      streamed = await hashAndBoundPreview(file, revision?.sha256, redactionLookaheadBytes);
    } catch (error) {
      if (error instanceof InvalidUtf8PreviewError) {
        return KnowledgeDocumentPreviewSchema.parse({
          ...base,
          isCurrent,
          supported: false,
          truncated: false,
          reason: "This file is not valid UTF-8. Download it instead.",
        });
      }
      throw error;
    }
    return KnowledgeDocumentPreviewSchema.parse({
      ...base,
      isCurrent,
      supported: true,
      text: this.redactPreviewText(streamed.text, streamed.redactionText),
      truncated: streamed.truncated,
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
      Partial<
        Pick<
          KnowledgeRepository,
          | "defaultBranch"
          | "selectedBranch"
          | "sourceVersion"
          | "error"
          | "sourceCommit"
          | "sourceRef"
          | "refreshedAt"
          | "refreshing"
          | "refreshError"
        >
      >,
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
      const nextState = structuredClone(this.state);
      nextState.knowledge[index] = next;
      await this.writeState(nextState);
      this.state = nextState;
      return structuredClone(next);
    });
  }

  async updateKnowledge(id: string, rawInput: unknown): Promise<KnowledgeItem> {
    const input = UpdateKnowledgeSchema.parse(rawInput);
    return this.withWrite(async () => {
      const nextState = structuredClone(this.state);
      const index = nextState.knowledge.findIndex((item) => item.id === id);
      const current = nextState.knowledge[index];
      if (!current) throw new StoreError("not_found", "Knowledge item not found.");
      if (current.kind === "repository" && current.status === "cloning") {
        throw new StoreError(
          "conflict",
          "Wait for the repository clone to finish before editing this item.",
        );
      }
      if (current.kind === "repository" && current.refreshing) {
        throw new StoreError(
          "conflict",
          "Wait for the source refresh to finish before editing this item.",
        );
      }
      if (
        input.handle &&
        input.handle !== current.handle &&
        nextState.knowledge.some(
          (item) => item.workspaceId === current.workspaceId && item.handle === input.handle,
        )
      ) {
        throw new StoreError("conflict", `#${input.handle} is already used in this workspace.`);
      }
      const updated = KnowledgeItemSchema.parse({
        ...current,
        ...input,
        updatedAt: new Date().toISOString(),
      });
      nextState.knowledge[index] = updated;
      await this.writeState(nextState);
      this.state = nextState;
      return structuredClone(updated);
    });
  }

  async deleteKnowledge(id: string): Promise<void> {
    return this.withWrite(async () => {
      const nextState = structuredClone(this.state);
      const index = nextState.knowledge.findIndex((item) => item.id === id);
      const item = nextState.knowledge[index];
      if (!item) throw new StoreError("not_found", "Knowledge item not found.");
      if (item.kind === "repository" && item.status === "cloning") {
        throw new StoreError(
          "conflict",
          "Wait for the repository clone to finish before deleting it.",
        );
      }
      if (item.kind === "repository" && item.refreshing) {
        throw new StoreError(
          "conflict",
          "Wait for the source refresh to finish before deleting this item.",
        );
      }
      const assignments = nextState.assignments.filter(
        (assignment) => assignment.repositoryId === item.id,
      );
      if (
        assignments.some(
          (assignment) => assignment.status === "queued" || assignment.status === "running",
        )
      ) {
        throw new StoreError(
          "conflict",
          "Wait for active Worker assignments to finish before deleting this repository.",
        );
      }
      const itemRoot = this.knowledgeStorageRoot(item);
      const tombstone = `${itemRoot}.deleting-${crypto.randomUUID()}`;
      let storageDetached = false;
      if (assignments.length === 0) {
        try {
          await rename(itemRoot, tombstone);
          storageDetached = true;
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw error;
        }
      }
      nextState.knowledge.splice(index, 1);
      try {
        await this.writeState(nextState);
      } catch (error) {
        if (storageDetached) await rename(tombstone, itemRoot).catch(() => undefined);
        throw error;
      }
      this.state = nextState;
      if (storageDetached) {
        await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  private requireExpectedDocumentRevision(
    item: KnowledgeDocument,
    expectedRevisionId: string,
  ): void {
    if (item.currentRevisionId) {
      if (item.currentRevisionId !== expectedRevisionId) {
        throw new StoreError(
          "conflict",
          "This document changed since it was loaded. Reload and try again.",
        );
      }
      return;
    }
    if (expectedRevisionId !== "legacy") {
      throw new StoreError(
        "conflict",
        "This document has no recorded version history yet. Reload and try again.",
      );
    }
  }

  private async captureLegacyDocumentRevision(
    state: PersistedState,
    index: number,
    now: string,
    createdPaths: string[],
  ): Promise<KnowledgeDocument> {
    const current = state.knowledge[index];
    if (current?.kind !== "document") {
      throw new StoreError("not_found", "Knowledge document not found.");
    }
    const bytes = await readFile(this.knowledgePath(current));
    const id = crypto.randomUUID();
    const storagePath = join(
      "workspaces",
      current.workspaceId,
      "knowledge",
      current.id,
      "revisions",
      id,
    );
    const file = this.managedPath(storagePath);
    await writePrivateFile(file, bytes);
    createdPaths.push(file);
    const legacyRevision = {
      id,
      createdAt: now,
      fileName: current.fileName,
      mediaType: current.mediaType,
      size: current.size,
      storagePath,
      sha256: hashBytes(bytes),
    } satisfies DocumentRevision;
    const item = KnowledgeDocumentSchema.parse({
      ...current,
      revisions: [legacyRevision],
      currentRevisionId: id,
      storagePath,
      updatedAt: now,
    });
    state.knowledge[index] = item;
    return item;
  }

  private newDocumentRevision(
    workspaceId: string,
    documentId: string,
    upload: UploadArtifactInput,
    createdAt: string,
    restoredFromId?: string,
  ): DocumentRevision {
    const id = crypto.randomUUID();
    return {
      id,
      createdAt,
      fileName: normaliseArtifactName(upload.name),
      mediaType: normaliseMediaType(upload.mediaType) || inferMediaType(upload.name),
      size: upload.bytes.byteLength,
      storagePath: join("workspaces", workspaceId, "knowledge", documentId, "revisions", id),
      sha256: hashBytes(upload.bytes),
      ...(restoredFromId ? { restoredFromId } : {}),
    };
  }

  private async pinKnowledgeReferences(
    state: PersistedState,
    message: Message,
  ): Promise<{ message: Message; createdPaths: string[] }> {
    const createdPaths: string[] = [];
    const references: KnowledgeReference[] = [];
    for (const reference of message.knowledgeReferences) {
      const index = state.knowledge.findIndex((item) => item.id === reference.knowledgeId);
      const item = state.knowledge[index];
      if (item?.kind !== "document") {
        references.push(reference);
        continue;
      }
      if (item.currentRevisionId) {
        references.push({ ...reference, revisionId: item.currentRevisionId });
        continue;
      }
      const captured = await this.captureLegacyDocumentRevision(
        state,
        index,
        message.createdAt,
        createdPaths,
      );
      references.push({ ...reference, revisionId: captured.currentRevisionId });
    }
    return {
      message: MessageSchema.parse({ ...message, knowledgeReferences: references }),
      createdPaths,
    };
  }

  knowledgePath(item: KnowledgeItem): string {
    return this.managedPath(item.storagePath);
  }

  private knowledgeStorageRoot(item: KnowledgeItem): string {
    const relative =
      item.kind === "repository"
        ? join("workspaces", item.workspaceId, "repositories", item.id)
        : join("workspaces", item.workspaceId, "knowledge", item.id);
    return this.managedPath(relative);
  }

  async agentKnowledge(message: Message): Promise<AgentKnowledgeItem[]> {
    const result: AgentKnowledgeItem[] = [];
    for (const reference of message.knowledgeReferences) {
      const item = this.getKnowledge(reference.knowledgeId);
      if (!item) continue;
      if (item.kind === "document" && reference.revisionId) {
        const revision = item.revisions.find((entry) => entry.id === reference.revisionId);
        if (!revision) continue;
        const revisionItem = KnowledgeItemSchema.parse({
          ...item,
          fileName: revision.fileName,
          mediaType: revision.mediaType,
          size: revision.size,
          storagePath: revision.storagePath,
          updatedAt: revision.createdAt,
        });
        const localPath = this.managedPath(revision.storagePath);
        if (isTextMediaType(revision.mediaType)) {
          const bytes = await readFile(localPath);
          if (hashBytes(bytes) !== revision.sha256) {
            throw new StoreError("invalid", "Document revision content is corrupted.");
          }
          const content = new TextDecoder().decode(bytes).slice(0, 512 * 1024);
          result.push({ item: revisionItem, localPath, content });
        } else {
          result.push({ item: revisionItem, localPath });
        }
        continue;
      }
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
      if (
        input.handle !== undefined &&
        this.state.agents.some(
          (agent) =>
            agent.id !== id &&
            agent.workspaceId === current.workspaceId &&
            agent.handle === input.handle,
        )
      ) {
        throw new StoreError("conflict", `@${input.handle} is already in use.`);
      }
      if (
        (current.kind === "worker" &&
          (input.provider !== undefined || input.accessMode !== undefined)) ||
        (current.kind === "master" &&
          (input.harness !== undefined ||
            input.model !== undefined ||
            input.reasoningEffort !== undefined))
      ) {
        throw new StoreError("invalid", "Configuration fields must match the agent's kind.");
      }

      const nextCredentials = { ...this.credentials };
      let provider = current.kind === "master" ? current.provider : undefined;
      if (input.provider?.type === "custom") {
        const credential = input.provider.removeCredential
          ? undefined
          : input.provider.apiKey || this.credentials[id];
        provider = {
          type: "custom",
          name: input.provider.name,
          baseUrl: normaliseBaseUrl(input.provider.baseUrl),
          model: input.provider.model,
          protocol: input.provider.protocol,
          hasCredential: Boolean(credential),
        };
        if (credential) nextCredentials[id] = credential;
        else delete nextCredentials[id];
      } else if (input.provider?.type === "chatgpt") {
        provider = input.provider;
        delete nextCredentials[id];
      }
      const baseInput = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.handle !== undefined ? { handle: input.handle } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      };
      const updated = AgentSchema.parse({
        ...current,
        ...baseInput,
        ...(current.kind === "worker"
          ? {
              harness: input.harness ?? current.harness,
              ...(input.model !== undefined && input.model !== null ? { model: input.model } : {}),
              ...(input.reasoningEffort !== undefined && input.reasoningEffort !== null
                ? { reasoningEffort: input.reasoningEffort }
                : {}),
            }
          : {
              accessMode: input.accessMode ?? current.accessMode,
              provider,
            }),
        enabled: input.archived === true ? false : (input.enabled ?? current.enabled),
        updatedAt: new Date().toISOString(),
      });
      if (current.kind === "worker") {
        if (input.model === null) delete (updated as { model?: unknown }).model;
        if (input.reasoningEffort === null) {
          delete (updated as { reasoningEffort?: unknown }).reasoningEffort;
        }
      }
      const nextState = structuredClone(this.state);
      nextState.agents[index] = updated;
      const credentialChanged = nextCredentials[id] !== this.credentials[id];
      if (credentialChanged) await this.writeCredentials(nextCredentials);
      try {
        await this.writeState(nextState);
      } catch (error) {
        if (credentialChanged) await this.writeCredentials(this.credentials);
        throw error;
      }
      this.credentials = nextCredentials;
      this.state = nextState;
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

  async renameThread(id: string, rawInput: unknown): Promise<Thread> {
    const input = RenameThreadSchema.parse(rawInput);
    return this.withWrite(async () => {
      const current = this.requireThread(id);
      if (current.name === input.name) return structuredClone(current);
      const updated = ThreadSchema.parse({
        ...current,
        name: input.name,
        slug: uniqueThreadSlug(
          input.name,
          this.state.threads.filter(
            (thread) => thread.workspaceId === current.workspaceId && thread.id !== id,
          ),
        ),
        updatedAt: new Date().toISOString(),
      });
      const next = {
        ...this.state,
        threads: this.state.threads.map((thread) => (thread.id === id ? updated : thread)),
      };
      await this.writeState(next);
      this.state = next;
      return structuredClone(updated);
    });
  }

  async archiveThread(id: string): Promise<Thread> {
    return this.withWrite(async () => {
      const current = this.requireThread(id);
      if (current.archived) return structuredClone(current);
      const data = await this.threadData(id);
      const activeRun = data.runs.find((run) =>
        ["queued", "running", "waiting_approval", "waiting_input"].includes(run.status),
      );
      if (
        activeRun ||
        this.state.assignments.some(
          (assignment) =>
            assignment.threadId === id &&
            (assignment.status === "queued" || assignment.status === "running"),
        )
      ) {
        throw new StoreError(
          "conflict",
          "Wait for this thread's agents and Worker assignments to finish before archiving it.",
        );
      }
      const updated = ThreadSchema.parse({
        ...current,
        archived: true,
        updatedAt: new Date().toISOString(),
      });
      const next = {
        ...this.state,
        threads: this.state.threads.map((thread) => (thread.id === id ? updated : thread)),
      };
      await this.writeState(next);
      this.state = next;
      return structuredClone(updated);
    });
  }

  async restoreThread(id: string): Promise<Thread> {
    return this.withWrite(async () => {
      const current = this.requireThread(id);
      if (!current.archived) return structuredClone(current);
      const updated = ThreadSchema.parse({
        ...current,
        archived: false,
        updatedAt: new Date().toISOString(),
      });
      const next = {
        ...this.state,
        threads: this.state.threads.map((thread) => (thread.id === id ? updated : thread)),
      };
      await this.writeState(next);
      this.state = next;
      return structuredClone(updated);
    });
  }

  async createUserMessage(
    threadId: string,
    content: string,
    mentions: Message["mentions"],
    uploads: UploadArtifactInput[] = [],
    knowledgeReferences: KnowledgeReference[] = [],
    requestId?: string,
  ): Promise<Message> {
    const normalizedRequestId = requestId === undefined ? undefined : normalizeRequestId(requestId);
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
      normalizedRequestId,
    );
  }

  async lookupUserSubmission(
    threadId: string,
    content: string,
    uploads: UploadArtifactInput[],
    requestId: string,
  ): Promise<Message | undefined> {
    validateUploads(uploads);
    const requestIdHash = hashRequestId(normalizeRequestId(requestId));
    const fingerprint = computeSubmissionFingerprint(content, uploads);
    return this.withWrite(() =>
      this.findSubmissionReplay(threadId, requestIdHash, fingerprint, uploads),
    );
  }

  private async findSubmissionReplay(
    threadId: string,
    requestIdHash: string,
    fingerprint: string,
    uploads: UploadArtifactInput[],
  ): Promise<Message | undefined> {
    const receipt = this.submissionReceipts.get(receiptKey(threadId, requestIdHash));
    if (!receipt) {
      await this.verifyTranscriptForSubmissionMiss(threadId);
      return undefined;
    }
    if (receipt.fingerprint !== fingerprint) {
      throw new StoreError(
        "conflict",
        "A different message was already stored with this request ID.",
      );
    }
    const message = await this.readReceiptMessage(threadId, receipt, uploads);
    await this.syncTranscriptDurability(threadId);
    await this.reconcileReplayMetadata(threadId);
    return message;
  }

  private async verifyTranscriptForSubmissionMiss(threadId: string): Promise<void> {
    const index = this.historyIndexes.get(threadId);
    let details: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      details = await stat(this.transcriptPath(threadId), { bigint: true });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw new StoreError(
          "conflict",
          "The stored submission transcript is unavailable; restart Nexestra before retrying.",
        );
      }
    }
    if (!details) {
      if (index === undefined) {
        if (!this.state.threads.some((thread) => thread.id === threadId)) {
          throw new StoreError("not_found", "Thread not found.");
        }
        return;
      }
      if (index.missing) return;
      throw new StoreError(
        "conflict",
        "The stored submission transcript disappeared; restart Nexestra before retrying.",
      );
    }
    if (index === undefined || index.missing) {
      throw new StoreError(
        "conflict",
        "The stored submission transcript appeared outside the app; restart Nexestra before retrying.",
      );
    }
    if (index.unreliable) {
      throw new StoreError(
        "conflict",
        "The stored submission transcript is unreliable; restart Nexestra before retrying.",
      );
    }
    if (index.identity) {
      const outcome = await readTranscriptPageLines(
        this.transcriptPath(threadId),
        index.identity,
        [],
      );
      if (outcome.status !== "ok") {
        throw new StoreError(
          "conflict",
          "The stored submission transcript changed outside the app; restart Nexestra before retrying.",
        );
      }
    }
  }

  private async syncTranscriptDurability(threadId: string): Promise<void> {
    if (!this.uncertainDurabilityThreads.has(threadId)) return;
    const handle = await open(this.transcriptPath(threadId), "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.uncertainDurabilityThreads.delete(threadId);
  }

  private async readReceiptMessage(
    threadId: string,
    receipt: UserSubmissionReceipt,
    uploads: UploadArtifactInput[],
  ): Promise<Message> {
    const index = this.historyIndexes.get(threadId);
    if (!index || index.unreliable || index.missing || !index.identity) {
      throw new StoreError(
        "conflict",
        "The stored submission transcript cannot be verified; restart Nexestra before retrying.",
      );
    }
    const lineLength = receipt.lineEnd - receipt.lineStart;
    if (lineLength <= 0 || lineLength > HISTORY_MAX_EVENT_BYTES) {
      throw new StoreError(
        "conflict",
        "The stored submission receipt is invalid; restart Nexestra before retrying.",
      );
    }
    const outcome = await readTranscriptPageLines(this.transcriptPath(threadId), index.identity, [
      {
        sequence: receipt.sequence,
        kind: "message",
        id: receipt.messageId,
        parentId: receipt.messageId,
        lineStart: receipt.lineStart,
        lineEnd: receipt.lineEnd,
        lineBytes: lineLength,
      },
    ]);
    if (outcome.status !== "ok") {
      throw new StoreError(
        "conflict",
        "The stored submission transcript changed or became unreadable outside the app; restart Nexestra before retrying.",
      );
    }
    const line = outcome.lines[0];
    if (line === undefined) {
      throw new StoreError(
        "conflict",
        "The stored submission receipt is invalid; restart Nexestra before retrying.",
      );
    }
    let event: TranscriptEvent | undefined;
    try {
      event = parseTranscriptEvent(line);
    } catch {
      throw new StoreError(
        "conflict",
        "The stored submission transcript is unreadable; restart Nexestra before retrying.",
      );
    }
    let submission: UserSubmissionEnvelope | "invalid" | undefined;
    try {
      submission = parseSubmissionEnvelope(
        (JSON.parse(line) as { submission?: unknown }).submission,
      );
    } catch {
      submission = "invalid";
    }
    if (
      event?.type !== "message.created" ||
      event.message.id !== receipt.messageId ||
      event.message.sequence !== receipt.sequence ||
      event.message.threadId !== threadId ||
      event.message.author.kind !== "user" ||
      submission === undefined ||
      submission === "invalid" ||
      submission.requestIdHash !== receipt.requestIdHash ||
      submission.fingerprint !== receipt.fingerprint
    ) {
      throw new StoreError(
        "conflict",
        "The stored submission receipt is inconsistent; restart Nexestra before retrying.",
      );
    }
    if (
      event.message.artifactIds.some(
        (artifactId) => !index.artifacts.some((entry) => entry.id === artifactId),
      )
    ) {
      if (submission.artifactPlan === undefined) {
        throw new StoreError(
          "conflict",
          "A stored submission is missing attachment records and its saved receipt cannot repair them; restore from a backup or restart Nexestra.",
        );
      }
      if (this.requireThread(threadId).archived) {
        throw new StoreError(
          "conflict",
          "Restore this thread before repairing its stored attachments.",
        );
      }
      await this.repairMissingArtifacts(threadId, event.message, submission.artifactPlan, uploads);
    }
    await this.verifySubmissionUploadFiles(threadId, event.message, uploads);
    return structuredClone(event.message);
  }

  private async verifySubmissionUploadFiles(
    threadId: string,
    message: Message,
    uploads: UploadArtifactInput[],
  ): Promise<void> {
    if (message.artifactIds.length === 0 || uploads.length === 0) return;
    const index = this.historyIndexes.get(threadId);
    if (!index || index.unreliable || index.missing || !index.identity) {
      throw new StoreError(
        "conflict",
        "Stored attachment records cannot be verified; restart Nexestra and retry.",
      );
    }
    for (const [position, artifactId] of message.artifactIds.entries()) {
      const entry = index.artifacts.find((candidate) => candidate.id === artifactId);
      if (!entry) {
        throw new StoreError(
          "conflict",
          "A stored submission is missing attachment records that could not be repaired; restart Nexestra and retry.",
        );
      }
      const outcome = await readTranscriptPageLines(this.transcriptPath(threadId), index.identity, [
        entry,
      ]);
      if (outcome.status !== "ok" || outcome.lines[0] === undefined) {
        throw new StoreError(
          "conflict",
          "Stored attachment records changed or became unreadable; restart Nexestra and retry.",
        );
      }
      let artifactEvent: TranscriptEvent | undefined;
      try {
        artifactEvent = parseTranscriptEvent(outcome.lines[0]);
      } catch {
        throw new StoreError(
          "conflict",
          "Stored attachment records are unreadable; restart Nexestra and retry.",
        );
      }
      if (artifactEvent?.type !== "artifact.created" || artifactEvent.artifact.id !== artifactId) {
        throw new StoreError(
          "conflict",
          "Stored attachment records are inconsistent; restart Nexestra and retry.",
        );
      }
      if (artifactEvent.artifact.source !== "upload") continue;
      const upload = uploads[position];
      if (!upload) {
        throw new StoreError(
          "conflict",
          "A stored submission references an attachment input that is missing; replay with the original file.",
        );
      }
      const file = this.uploadArtifactPath(threadId, artifactId);
      let existing: Buffer;
      try {
        existing = await readFile(file);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          throw new StoreError(
            "conflict",
            "A stored attachment file is missing; replay the submission with the original file to restore it.",
          );
        }
        throw error;
      }
      if (hashBytes(existing) !== hashBytes(upload.bytes)) {
        throw new StoreError(
          "conflict",
          "A stored attachment file no longer matches the submission; restart Nexestra or restore the file.",
        );
      }
    }
  }

  private async repairMissingArtifacts(
    threadId: string,
    message: Message,
    plan: UserSubmissionArtifactPlanEntry[],
    uploads: UploadArtifactInput[],
  ): Promise<void> {
    const index = this.historyIndexes.get(threadId);
    if (!index || index.unreliable || index.missing) {
      throw new StoreError(
        "conflict",
        "Stored attachment records cannot be verified; restart Nexestra and retry.",
      );
    }
    const planByArtifactId = new Map(plan.map((entry) => [entry.id, entry]));
    let nextSequence = await this.nextSequence(threadId);
    const events: TranscriptEvent[] = [];
    for (const [position, artifactId] of message.artifactIds.entries()) {
      if (index.artifacts.some((entry) => entry.id === artifactId)) continue;
      const entry = planByArtifactId.get(artifactId);
      if (!entry) {
        throw new StoreError(
          "conflict",
          "A stored submission is missing attachment records that its saved receipt cannot reproduce; restore from a backup or restart Nexestra.",
        );
      }
      if (entry.source === "upload") {
        const upload = uploads[position];
        if (!upload) {
          throw new StoreError(
            "conflict",
            "A stored submission references an attachment input that is missing; replay with the original file.",
          );
        }
        await writeKeyedUploadFile(this.uploadArtifactPath(threadId, artifactId), upload.bytes);
      }
      const artifact = ArtifactSchema.parse({
        ...entry,
        threadId,
        messageId: message.id,
        sequence: nextSequence,
      });
      nextSequence += 1;
      events.push({ type: "artifact.created", sequence: artifact.sequence, artifact });
    }
    if (events.length === 0) return;
    let appended: { baseOffset: number; endOffset: number } | undefined;
    try {
      appended = await appendManySynced(this.transcriptPath(threadId), events);
    } catch (error) {
      if (!appended) {
        await repairTranscriptTail(this.transcriptPath(threadId));
        const repairedIndex = await this.primeTranscriptIndex(threadId);
        this.sequenceByThread.set(threadId, transcriptIndexMaxSequence(repairedIndex));
        this.uncertainDurabilityThreads.add(threadId);
        try {
          await this.syncTranscriptDurability(threadId);
        } catch {
          // Keep the uncertain flag; retry must sync before returning a message.
        }
      }
      throw error;
    }
    try {
      await this.extendTranscriptIndex(threadId, appended.baseOffset, events);
    } catch (error) {
      await this.primeTranscriptIndex(threadId).catch(() => undefined);
      throw error;
    }
    this.sequenceByThread.set(
      threadId,
      Math.max(this.sequenceByThread.get(threadId) ?? 0, events.at(-1)?.sequence ?? 0),
    );
  }

  private async reconcileReplayMetadata(threadId: string): Promise<void> {
    if (!this.dirtyMetadataThreads.has(threadId)) return;
    await this.writeState(this.state);
    this.dirtyMetadataThreads.delete(threadId);
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
      const event = {
        type: "run.updated",
        sequence,
        run,
      } satisfies TranscriptEvent;
      const appended = await appendSynced(this.transcriptPath(run.threadId), event);
      await this.extendTranscriptIndex(run.threadId, appended.baseOffset, [event]);
      this.sequenceByThread.set(run.threadId, sequence);
      return structuredClone(run);
    });
  }

  async updateToolCall(toolCall: ToolCall): Promise<ToolCall> {
    ToolCallSchema.parse(toolCall);
    return this.withWrite(async () => {
      this.requireThread(toolCall.threadId);
      const sequence = await this.nextSequence(toolCall.threadId);
      const event = {
        type: "tool.updated",
        sequence,
        toolCall,
      } satisfies TranscriptEvent;
      const appended = await appendSynced(this.transcriptPath(toolCall.threadId), event);
      await this.extendTranscriptIndex(toolCall.threadId, appended.baseOffset, [event]);
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

  async exportThreadMarkdown(threadId: string): Promise<string> {
    const thread = this.requireThread(threadId);
    const data = await this.threadData(threadId);
    const lines: string[] = [];
    lines.push(`# ${thread.name}`);
    lines.push("");
    lines.push(`> Exported from Nexestra on ${new Date().toLocaleString()}`);
    lines.push("");

    // Group messages by date
    const messagesByDate = new Map<string, typeof data.messages>();
    for (const message of data.messages) {
      const date = message.createdAt.split("T")[0] ?? "unknown";
      const existing = messagesByDate.get(date) ?? [];
      existing.push(message);
      messagesByDate.set(date, existing);
    }

    const artifactsByMessage = new Map<string, Artifact[]>();
    for (const artifact of data.artifacts) {
      const artifacts = artifactsByMessage.get(artifact.messageId) ?? [];
      artifacts.push(artifact);
      artifactsByMessage.set(artifact.messageId, artifacts);
    }

    for (const [date, messages] of messagesByDate) {
      const formattedDate = new Date(date).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      lines.push(`## ${formattedDate}`);
      lines.push("");

      for (const message of messages) {
        const time = new Date(message.createdAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        const authorLabel =
          message.author.kind === "agent"
            ? `**${message.author.name}** @${message.author.handle}`
            : `**${message.author.name}**`;

        lines.push(`### ${authorLabel} — ${time}`);
        lines.push("");
        lines.push(
          message.content
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        );
        lines.push("");

        // Include artifacts
        const artifacts = artifactsByMessage.get(message.id) ?? [];
        if (artifacts.length > 0) {
          lines.push("**Attachments:**");
          for (const artifact of artifacts) {
            if (artifact.kind === "link") {
              lines.push(`- [Link] ${artifact.name}: ${artifact.url}`);
            } else if (artifact.kind === "image") {
              lines.push(`- [Image] ${artifact.name}`);
            } else {
              lines.push(
                `- [File] ${artifact.name}${artifact.size ? ` (${formatBytes(artifact.size)})` : ""}`,
              );
            }
          }
          lines.push("");
        }

        // Include knowledge references
        if (message.knowledgeReferences.length > 0) {
          lines.push(
            `**Knowledge:** ${message.knowledgeReferences.map((ref) => `#${ref.handle}`).join(", ")}`,
          );
          lines.push("");
        }

        lines.push("---");
        lines.push("");
      }
    }

    return lines.join("\n");
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
        verificationCommand: input.verificationCommand,
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

  async deleteTask(id: string): Promise<void> {
    return this.withWrite(async () => {
      const nextState = structuredClone(this.state);
      const index = nextState.tasks.findIndex((task) => task.id === id);
      if (index === -1) throw new StoreError("not_found", "Task not found.");
      if (
        nextState.assignments.some(
          (assignment) =>
            assignment.taskId === id &&
            (assignment.status === "queued" || assignment.status === "running"),
        )
      ) {
        throw new StoreError(
          "conflict",
          "Wait for the active Worker assignment to finish before deleting this task.",
        );
      }
      nextState.tasks.splice(index, 1);
      await this.writeState(nextState);
      this.state = nextState;
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
    update: Partial<
      Pick<
        WorkAssignment,
        | "status"
        | "result"
        | "error"
        | "verificationOutput"
        | "verificationExitCode"
        | "worktreeCleanedAt"
        | "branchDeletedAt"
        | "baseCommit"
      >
    >,
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
    requestId?: string,
  ): Promise<Message> {
    return this.withWrite(async () => {
      const threadIndex = this.state.threads.findIndex((thread) => thread.id === threadId);
      const currentThread = this.state.threads[threadIndex];
      if (!currentThread) throw new StoreError("not_found", "Thread not found.");
      validateUploads(uploads);
      const requestIdHash = requestId ? hashRequestId(requestId) : undefined;
      const submissionFingerprint = requestId
        ? computeSubmissionFingerprint(input.content, uploads)
        : undefined;
      const keyedUploadIds = requestId
        ? prepareSubmissionUploadIds(threadId, requestId, uploads)
        : undefined;
      if (requestId && requestIdHash && submissionFingerprint) {
        const replay = await this.findSubmissionReplay(
          threadId,
          requestIdHash,
          submissionFingerprint,
          uploads,
        );
        if (replay !== undefined) return replay;
      }
      if (currentThread.archived) {
        throw new StoreError(
          "conflict",
          "Archived threads are read-only. Restore the thread before sending new messages.",
        );
      }
      const artifactDrafts = await this.createArtifactDrafts(input, uploads, keyedUploadIds);
      const messageSequence = await this.nextSequence(threadId);
      const artifacts = artifactDrafts.map((draft, index) =>
        ArtifactSchema.parse({ ...draft, sequence: messageSequence + index + 1 }),
      );
      const artifactPlan = artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        source: artifact.source,
        name: artifact.name,
        ...(artifact.mediaType !== undefined ? { mediaType: artifact.mediaType } : {}),
        ...(artifact.size !== undefined ? { size: artifact.size } : {}),
        ...(artifact.url !== undefined ? { url: artifact.url } : {}),
        ...(artifact.path !== undefined ? { path: artifact.path } : {}),
        createdAt: artifact.createdAt,
      }));
      const baseMessage = MessageSchema.parse({
        ...input,
        artifactIds: artifacts.map((artifact) => artifact.id),
        sequence: messageSequence,
      });
      const nextState = structuredClone(this.state);
      let persistedMessage = baseMessage;
      let createdRevisionPaths: string[] = [];
      if (input.author.kind === "user") {
        const pinned = await this.pinKnowledgeReferences(nextState, baseMessage);
        persistedMessage = pinned.message;
        createdRevisionPaths = pinned.createdPaths;
      }
      if (createdRevisionPaths.length > 0) {
        try {
          await this.writeState(nextState);
        } catch (error) {
          await Promise.all(
            createdRevisionPaths.map((file) => unlink(file).catch(() => undefined)),
          );
          throw error;
        }
        this.state = nextState;
      }
      const thread = nextState.threads[threadIndex];
      if (!thread) throw new StoreError("not_found", "Thread not found.");
      const writtenUploads: string[] = [];
      let appended: { baseOffset: number; endOffset: number } | undefined;
      try {
        for (const draft of artifactDrafts) {
          if (!draft.bytes) continue;
          const file = this.uploadArtifactPath(threadId, draft.id);
          if (keyedUploadIds?.includes(draft.id) === true) {
            // Keyed files survive by design: crash orphans are byte-verified
            // and reused, and a durable transcript must never lose a reference.
            await writeKeyedUploadFile(file, draft.bytes);
          } else {
            await writePrivateFile(file, draft.bytes);
            writtenUploads.push(file);
          }
        }
        const events = [
          {
            type: "message.created",
            sequence: messageSequence,
            message: persistedMessage,
            ...(requestIdHash && submissionFingerprint
              ? { submission: { requestIdHash, fingerprint: submissionFingerprint, artifactPlan } }
              : {}),
          },
          ...artifacts.map(
            (artifact): TranscriptEvent => ({
              type: "artifact.created",
              sequence: artifact.sequence,
              artifact,
            }),
          ),
        ] satisfies TranscriptEvent[];
        appended = await appendManySynced(this.transcriptPath(threadId), events);
        if (requestIdHash && submissionFingerprint) {
          const messageEvent = events[0];
          const messageLineBytes = Buffer.byteLength(JSON.stringify(messageEvent), "utf8") + 1;
          this.submissionReceipts.set(receiptKey(threadId, requestIdHash), {
            requestIdHash,
            fingerprint: submissionFingerprint,
            messageId: persistedMessage.id,
            sequence: messageSequence,
            lineStart: appended.baseOffset,
            lineEnd: appended.baseOffset + messageLineBytes,
          });
        }
        await this.extendTranscriptIndex(threadId, appended.baseOffset, events);
      } catch (error) {
        if (!appended) {
          await repairTranscriptTail(this.transcriptPath(threadId));
          const repairedIndex = await this.primeTranscriptIndex(threadId);
          this.sequenceByThread.set(threadId, transcriptIndexMaxSequence(repairedIndex));
          const durableMessage = repairedIndex.messages.some(
            (entry) => entry.sequence === messageSequence,
          );
          if (durableMessage) {
            this.uncertainDurabilityThreads.add(threadId);
            try {
              await this.syncTranscriptDurability(threadId);
            } catch {
              // Keep the uncertain flag; retry must sync before returning.
            }
            const lastMessageEntry = repairedIndex.messages.at(-1);
            if (lastMessageEntry && repairedIndex.identity) {
              const lastRead = await readTranscriptPageLines(
                this.transcriptPath(threadId),
                repairedIndex.identity,
                [lastMessageEntry],
              );
              if (lastRead.status === "ok" && lastRead.lines[0] !== undefined) {
                try {
                  const lastEvent = parseTranscriptEvent(lastRead.lines[0]);
                  if (lastEvent?.type === "message.created") {
                    thread.messageCount = repairedIndex.messages.length;
                    thread.lastMessageAt = lastEvent.message.createdAt;
                    thread.updatedAt = lastEvent.message.createdAt;
                    this.state = nextState;
                    this.dirtyMetadataThreads.add(threadId);
                  }
                } catch {
                  // Counters stay stale until the next state write or restart repair.
                }
              }
            }
          } else {
            await Promise.all(writtenUploads.map((file) => unlink(file).catch(() => undefined)));
          }
        } else {
          // The append is durable but a later index extension failed; re-prime so
          // receipts and history reads see the canonical bytes without duplication.
          const repairedIndex = await this.primeTranscriptIndex(threadId).catch(() => undefined);
          if (repairedIndex) {
            this.sequenceByThread.set(threadId, transcriptIndexMaxSequence(repairedIndex));
          }
        }
        throw error;
      }
      this.sequenceByThread.set(threadId, artifacts.at(-1)?.sequence ?? messageSequence);
      thread.messageCount += 1;
      thread.lastMessageAt = persistedMessage.createdAt;
      thread.updatedAt = persistedMessage.createdAt;
      this.state = nextState;
      try {
        await this.writeState(this.state);
      } catch (error) {
        this.dirtyMetadataThreads.add(threadId);
        throw error;
      }
      this.dirtyMetadataThreads.delete(threadId);
      return structuredClone(persistedMessage);
    });
  }
  private async createArtifactDrafts(
    message: Omit<Message, "sequence">,
    uploads: UploadArtifactInput[],
    keyedUploadIds?: string[],
  ): Promise<ArtifactDraft[]> {
    validateUploads(uploads);
    const drafts: ArtifactDraft[] = uploads.map((upload, index) => {
      const mediaType = normaliseMediaType(upload.mediaType) || inferMediaType(upload.name);
      return {
        id: keyedUploadIds?.[index] ?? crypto.randomUUID(),
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
        name: artifactReferenceName(url),
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

  async historyPage(
    workspaceId: string,
    threadId: string,
    input: ThreadHistoryRequest,
    activeRuns: AgentRun[] = [],
  ): Promise<ThreadHistoryPage> {
    const thread = this.requireThread(threadId);
    if (thread.workspaceId !== workspaceId) {
      throw new StoreError("not_found", "Thread not found in this workspace.");
    }
    return this.withWrite(async () => {
      const index =
        this.historyIndexes.get(threadId) ?? (await this.primeTranscriptIndex(threadId));
      const mode: HistoryAnchorMode = input.before
        ? "before"
        : input.after
          ? "after"
          : input.around
            ? "around"
            : input.at !== undefined
              ? "at"
              : "latest";
      const anchor = input.before ?? input.after ?? input.around;
      if (index.missing) {
        const emptyThread = thread.messageCount === 0 && thread.lastMessageAt === null;
        if (mode === "before" || mode === "after") {
          throw new StoreError("invalid", "Unknown message anchor in this thread.");
        }
        if (!emptyThread) {
          throw new StoreError(
            "conflict",
            "Transcript file is missing; restart Nexestra before requesting history.",
          );
        }
        let transcriptExists = false;
        try {
          await stat(this.transcriptPath(threadId));
          transcriptExists = true;
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) {
            throw new StoreError(
              "conflict",
              "Transcript status is unavailable; restart Nexestra before requesting history.",
            );
          }
        }
        if (transcriptExists) {
          throw new StoreError(
            "conflict",
            "Transcript appeared outside the app; restart Nexestra before requesting history.",
          );
        }
        return ThreadHistoryPageSchema.parse({
          thread: this.redactedThread(thread),
          messages: [],
          artifacts: [],
          runs: [],
          toolCalls: [],
          activeRuns: activeRuns.map((run) => this.redactedRun(run)),
          page: {
            totalMessages: 0,
            totalArtifacts: 0,
            firstMessageIndex: 0,
            lastMessageIndex: 0,
            beforeCursor: null,
            afterCursor: null,
            ...(mode === "around" ? { targetMessageId: anchor, targetFound: false } : {}),
            ...(mode === "at" && input.at !== undefined
              ? { targetMessageIndex: input.at, targetFound: false }
              : {}),
          },
        });
      }
      if (index.unreliable) {
        throw new StoreError(
          "conflict",
          "Transcript contains malformed or oversized lines; restart Nexestra before requesting history.",
        );
      }
      if (!index.identity) {
        throw new StoreError(
          "conflict",
          "Transcript identity is unavailable; restart Nexestra before requesting history.",
        );
      }
      const result =
        mode === "at" && input.at !== undefined
          ? planHistoryPageAt(index, input.at, input.limit)
          : planHistoryPage(index, mode, anchor, input.limit);
      if (!result.ok) {
        throw new StoreError("invalid", result.reason ?? "Unknown message anchor.");
      }
      const plan = result.plan;
      const selected = [
        ...plan.messageEntries,
        ...plan.artifactEntries,
        ...plan.runEntries,
        ...plan.toolEntries,
      ];
      const pageBytes = selected.reduce((total, entry) => total + entry.lineBytes, 0);
      if (
        selected.some((entry) => entry.lineBytes > HISTORY_MAX_EVENT_BYTES) ||
        pageBytes > HISTORY_MAX_PAGE_BYTES
      ) {
        throw new StoreError(
          "invalid",
          "History page exceeds the event/page byte budget; narrow the page and retry.",
        );
      }
      const outcome = await readTranscriptPageLines(
        this.transcriptPath(threadId),
        index.identity,
        selected,
      );
      if (outcome.status !== "ok") {
        throw new StoreError(
          "conflict",
          "Transcript changed or became unavailable outside the app; restart Nexestra before requesting history.",
        );
      }
      const messages = new Map<string, Message>();
      const artifacts = new Map<string, Artifact>();
      const runs = new Map<string, AgentRun>();
      const toolCalls = new Map<string, ToolCall>();
      for (let i = 0; i < selected.length; i += 1) {
        const entry = selected[i];
        if (!entry)
          throw new StoreError("conflict", "History index is inconsistent; restart Nexestra.");
        const line = outcome.lines[i];
        let event: TranscriptEvent | undefined;
        try {
          event = parseTranscriptEvent(stripTrailingNewline(line ?? ""));
        } catch {
          throw new StoreError("conflict", "History index is inconsistent; restart Nexestra.");
        }
        if (
          !event ||
          (entry.kind === "message" && event.type !== "message.created") ||
          (entry.kind === "artifact" && event.type !== "artifact.created") ||
          (entry.kind === "run" && event.type !== "run.updated") ||
          (entry.kind === "tool" && event.type !== "tool.updated")
        ) {
          throw new StoreError("conflict", "History index is inconsistent; restart Nexestra.");
        }
        if (event.type === "message.created") messages.set(event.message.id, event.message);
        if (event.type === "artifact.created") artifacts.set(event.artifact.id, event.artifact);
        if (event.type === "run.updated") runs.set(event.run.id, event.run);
        if (event.type === "tool.updated") toolCalls.set(event.toolCall.id, event.toolCall);
      }
      const pageMessages = plan.messageEntries
        .map((entry) => messages.get(entry.id))
        .filter((message): message is Message => message !== undefined);
      const pageArtifacts = plan.artifactEntries
        .map((entry) => artifacts.get(entry.id))
        .filter((artifact): artifact is Artifact => artifact !== undefined);
      const pageRuns = plan.runEntries
        .map((entry) => runs.get(entry.id))
        .filter((run): run is AgentRun => run !== undefined);
      const pageToolCalls = plan.toolEntries
        .map((entry) => toolCalls.get(entry.id))
        .filter((toolCall): toolCall is ToolCall => toolCall !== undefined);
      if (
        pageMessages.length !== plan.messageEntries.length ||
        pageArtifacts.length !== plan.artifactEntries.length ||
        pageRuns.length !== plan.runEntries.length ||
        pageToolCalls.length !== plan.toolEntries.length
      ) {
        throw new StoreError("conflict", "History index is inconsistent; restart Nexestra.");
      }
      return ThreadHistoryPageSchema.parse({
        thread: this.redactedThread(thread),
        messages: pageMessages.map((message) => this.redactedMessage(message)),
        artifacts: pageArtifacts.map((artifact) => this.redactedArtifact(artifact)),
        runs: pageRuns.map((run) => this.redactedRun(run)),
        toolCalls: pageToolCalls.map((toolCall) => this.redactedToolCall(toolCall)),
        activeRuns: activeRuns.map((run) => this.redactedRun(run)),
        page: {
          totalMessages: index.messages.length,
          totalArtifacts: index.artifacts.length,
          firstMessageIndex: plan.firstMessageIndex,
          lastMessageIndex: plan.lastMessageIndex,
          beforeCursor: plan.beforeCursor,
          afterCursor: plan.afterCursor,
          ...(plan.targetMessageId ? { targetMessageId: plan.targetMessageId } : {}),
          ...(plan.targetFound !== undefined ? { targetFound: plan.targetFound } : {}),
          ...(plan.targetMessageIndex !== undefined
            ? { targetMessageIndex: plan.targetMessageIndex }
            : {}),
        },
      });
    });
  }

  async listRunHistory(rawInput: unknown): Promise<RunHistoryPage> {
    const input = RunHistoryRequestSchema.parse(rawInput);
    return this.withWrite(async () => {
      const workspace = this.requireWorkspace(input.workspaceId);
      if (input.threadId) {
        const thread = this.getThread(input.threadId);
        if (!thread || thread.workspaceId !== workspace.id) {
          throw new StoreError("not_found", "Thread not found in this workspace.");
        }
      }
      if (input.agentId) {
        const agent = this.getAgent(input.agentId);
        if (!agent || agent.workspaceId !== workspace.id) {
          throw new StoreError("not_found", "Agent not found in this workspace.");
        }
      }
      let cursor: RunHistoryCursorPayload | undefined;
      if (input.cursor !== undefined) {
        try {
          cursor = decodeRunHistoryCursor(input.cursor);
        } catch {
          throw new StoreError("invalid", "Run history cursor is invalid.");
        }
        if (!cursor) {
          throw new StoreError("invalid", "Run history cursor is invalid.");
        }
        if (
          cursor.workspaceId !== input.workspaceId ||
          cursor.agentId !== input.agentId ||
          cursor.threadId !== input.threadId ||
          cursor.status !== input.status ||
          cursor.limit !== input.limit
        ) {
          throw new StoreError("invalid", "Run history cursor does not match this request.");
        }
      }
      const scopedThreads = this.state.threads.filter(
        (thread) => thread.workspaceId === workspace.id,
      );
      const coverageThreads =
        input.threadId === undefined
          ? scopedThreads
          : scopedThreads.filter((thread) => thread.id === input.threadId);
      let unavailableThreads = 0;
      const summaries: RunHistorySummary[] = [];
      const foreignAgentIds = new Set(
        this.state.agents
          .filter((agent) => agent.workspaceId !== workspace.id)
          .map((agent) => agent.id),
      );
      for (const thread of coverageThreads) {
        const index =
          this.historyIndexes.get(thread.id) ?? (await this.primeTranscriptIndex(thread.id));
        const emptyKnownThread = thread.messageCount === 0 && thread.lastMessageAt === null;
        if ((index.missing && !emptyKnownThread) || index.unreliable) {
          unavailableThreads += 1;
          continue;
        }
        let foreignSummary = false;
        for (const summary of index.runHistory.values()) {
          if (summary.threadId !== thread.id || foreignAgentIds.has(summary.agentId)) {
            foreignSummary = true;
            break;
          }
        }
        if (foreignSummary) {
          unavailableThreads += 1;
          continue;
        }
        for (const summary of index.runHistory.values()) {
          if (input.agentId !== undefined && summary.agentId !== input.agentId) continue;
          if (input.threadId !== undefined && summary.threadId !== input.threadId) continue;
          if (input.status !== undefined && summary.status !== input.status) continue;
          summaries.push(summary);
        }
      }
      summaries.sort(compareRunHistorySummaries);
      const remaining =
        cursor === undefined
          ? summaries
          : summaries.filter((summary) => runHistorySummaryAfterCursor(summary, cursor));
      const pageSummaries = remaining.slice(0, input.limit);
      const agents = new Map(
        this.state.agents
          .filter((agent) => agent.workspaceId === workspace.id)
          .map((agent) => [agent.id, agent]),
      );
      const threads = new Map(
        this.state.threads
          .filter((entry) => entry.workspaceId === workspace.id)
          .map((entry) => [entry.id, entry]),
      );
      const items = pageSummaries.map((summary): RunHistoryItem => {
        const agent = agents.get(summary.agentId);
        const thread = threads.get(summary.threadId);
        return {
          run: {
            id: summary.id,
            threadId: summary.threadId,
            triggerMessageId: summary.triggerMessageId,
            agentId: summary.agentId,
            attempt: summary.attempt,
            status: summary.status,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt,
          },
          agentName: agent ? this.redactSecrets(agent.name) : "Unknown",
          agentHandle: agent ? this.redactHandleValue(agent.handle) : undefined,
          threadName: thread ? this.redactSecrets(thread.name) : "Unknown",
          threadArchived: thread?.archived ?? false,
        };
      });
      const lastSummary = pageSummaries[pageSummaries.length - 1];
      const nextCursor =
        lastSummary && remaining.length > input.limit
          ? encodeRunHistoryCursor(input, lastSummary)
          : null;
      return RunHistoryPageSchema.parse({
        workspaceId: workspace.id,
        items,
        page: { nextCursor },
        coverage: { complete: unavailableThreads === 0, unavailableThreads },
      });
    });
  }

  private async primeTranscriptIndexes(): Promise<void> {
    for (const thread of this.state.threads) {
      await this.primeTranscriptIndex(thread.id);
    }
  }

  private async primeTranscriptIndex(threadId: string): Promise<TranscriptHistoryIndex> {
    const index = emptyTranscriptHistoryIndex(threadId);
    const file = this.transcriptPath(threadId);
    const outcome = await scanTranscriptHistoryFile(file, {
      maxLineBytes: HISTORY_MAX_EVENT_BYTES,
      onLine: (line, lineStart, lineEnd) => {
        let raw: RawTranscriptEvent;
        try {
          raw = JSON.parse(line) as RawTranscriptEvent;
        } catch {
          return { status: "malformed" };
        }
        let event: TranscriptEvent | undefined;
        try {
          event = parseTranscriptEvent(line);
        } catch {
          return { status: "malformed" };
        }
        if (!event) return { status: "unknown" };
        if (event.type === "message.created") {
          const submission = parseSubmissionEnvelope((raw as { submission?: unknown }).submission);
          if (submission === "invalid") return { status: "malformed" };
          if (submission) {
            const accepted = upsertSubmissionReceipt(
              this.submissionReceipts,
              threadId,
              submission,
              event.message.id,
              event.sequence,
              lineStart,
              lineEnd,
            );
            if (!accepted) return { status: "malformed" };
          }
        }
        const entry = transcriptHistoryEntry(event.sequence, raw, lineStart, lineEnd);
        if (!entry) return { status: "unknown" };
        addTranscriptHistoryEntry(index, entry);
        if (event.type === "run.updated") {
          setRunHistorySummary(index, this.runHistorySummaryOf(event.run));
        }
        return { status: "event", raw };
      },
    });
    index.messages.sort((left, right) => left.sequence - right.sequence);
    index.artifacts.sort((left, right) => left.sequence - right.sequence);
    if (outcome.status === "missing") {
      index.missing = true;
      this.historyIndexes.set(threadId, index);
      return index;
    }
    index.malformedLines = outcome.malformedLines;
    index.oversizedLines = outcome.oversizedLines;
    index.invalidUtf8Lines = outcome.invalidUtf8Lines;
    index.tornTailLines = outcome.tornTailLines;
    index.unknownEventLines = outcome.unknownEventLines;
    index.unreliable =
      outcome.status === "unreadable" ||
      outcome.malformedLines > 0 ||
      outcome.oversizedLines > 0 ||
      outcome.invalidUtf8Lines > 0 ||
      outcome.tornTailLines > 0;
    if (outcome.status === "ok") {
      try {
        const info = await stat(file, { bigint: true });
        index.identity = transcriptFileIdentityOf(info);
      } catch {
        index.unreliable = true;
      }
    }
    this.historyIndexes.set(threadId, index);
    return index;
  }

  private async extendTranscriptIndex(
    threadId: string,
    baseOffset: number,
    events: TranscriptEvent[],
  ): Promise<void> {
    const existing = this.historyIndexes.get(threadId);
    if (!existing) {
      // A thread created after startup has no index yet; prime the just-durable
      // canonical file so receipt and history reads work without reopening.
      await this.primeTranscriptIndex(threadId);
      return;
    }
    if (existing.unreliable) return;
    const index = existing;
    let offset = baseOffset;
    for (const event of events) {
      const line = JSON.stringify(event);
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      let raw: RawTranscriptEvent;
      try {
        raw = JSON.parse(line) as RawTranscriptEvent;
      } catch {
        index.unreliable = true;
        return;
      }
      const entry = transcriptHistoryEntry(event.sequence, raw, offset, offset + lineBytes);
      if (entry) addTranscriptHistoryEntry(index, entry);
      if (event.type === "run.updated") {
        setRunHistorySummary(index, this.runHistorySummaryOf(event.run));
      }
      offset += lineBytes;
    }
    try {
      const info = await stat(this.transcriptPath(threadId), { bigint: true });
      index.identity = transcriptFileIdentityOf(info);
      index.missing = false;
    } catch {
      index.unreliable = true;
    }
  }

  private redactedThread(thread: Thread): Thread {
    return {
      ...thread,
      name: this.redactSecrets(thread.name),
      slug: this.redactSecrets(thread.slug),
    };
  }

  private runHistorySummaryOf(run: AgentRun): RunHistorySummary {
    return {
      id: run.id,
      threadId: run.threadId,
      triggerMessageId: run.triggerMessageId,
      agentId: run.agentId,
      attempt: run.attempt,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private redactHandleValue(value: string): string {
    const redacted = this.redactSecrets(value);
    return redacted === value ? value : "redacted";
  }

  private redactedMessage(message: Message): Message {
    const copy = structuredClone(message);
    copy.content = this.redactSecrets(copy.content);
    copy.author = { ...copy.author, name: this.redactSecrets(copy.author.name) };
    if (copy.author.kind === "agent") {
      copy.author.handle = this.redactHandleValue(copy.author.handle);
    }
    copy.mentions = copy.mentions.map((mention) => ({
      ...mention,
      handle: this.redactHandleValue(mention.handle),
    }));
    copy.knowledgeReferences = copy.knowledgeReferences.map((reference) => ({
      ...reference,
      handle: this.redactHandleValue(reference.handle),
    }));
    return copy;
  }

  private redactedArtifact(artifact: Artifact): Artifact {
    const copy = structuredClone(artifact);
    copy.name = this.redactSecrets(copy.name).slice(0, 255);
    if (copy.mediaType !== undefined)
      copy.mediaType = this.redactSecrets(copy.mediaType).slice(0, 160);
    if (copy.url !== undefined) copy.url = this.redactSecrets(copy.url).slice(0, 4_096);
    if (copy.path !== undefined) copy.path = this.redactSecrets(copy.path).slice(0, 1_024);
    return copy;
  }

  private redactedRun(run: AgentRun): AgentRun {
    const copy = structuredClone(run);
    if (copy.error !== undefined) copy.error = this.redactSecrets(copy.error).slice(0, 2_000);
    return copy;
  }

  private redactedToolCall(toolCall: ToolCall): ToolCall {
    const copy = structuredClone(toolCall);
    copy.input = this.redactSecrets(copy.input).slice(0, 4_000);
    if (copy.questions) {
      copy.questions = copy.questions.map((question) => ({
        ...question,
        header: this.redactSecrets(question.header).slice(0, 30),
        question: this.redactSecrets(question.question).slice(0, 500),
        options: question.options.map((option) => ({
          ...option,
          label: this.redactSecrets(option.label).slice(0, 100),
          description: this.redactSecrets(option.description).slice(0, 300),
        })),
      }));
    }
    if (copy.answers) {
      copy.answers = copy.answers.map((group) =>
        group.map((value) => this.redactSecrets(value).slice(0, 500)),
      );
    }
    if (copy.summary !== undefined) copy.summary = this.redactSecrets(copy.summary).slice(0, 500);
    if (copy.error !== undefined) copy.error = this.redactSecrets(copy.error).slice(0, 2_000);
    return copy;
  }
  private async repairTranscriptTails(): Promise<void> {
    for (const thread of this.state.threads) {
      await repairTranscriptTail(this.transcriptPath(thread.id));
    }
  }

  private async repairThreadSummaries(): Promise<void> {
    let changed = false;
    for (const thread of this.state.threads) {
      const index = this.historyIndexes.get(thread.id);
      const events = await this.readEvents(thread.id);
      const messages = events.filter((event) => event.type === "message.created");
      const last = messages.at(-1)?.message;
      this.sequenceByThread.set(thread.id, events.at(-1)?.sequence ?? 0);
      const knownNonemptyBefore = thread.messageCount > 0 || thread.lastMessageAt !== null;
      const missingKnownNonempty = index?.missing === true && knownNonemptyBefore;
      if (
        !missingKnownNonempty &&
        (thread.messageCount !== messages.length ||
          thread.lastMessageAt !== (last?.createdAt ?? null))
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

  private async recoverInterruptedRepositories(): Promise<void> {
    const interrupted = this.state.knowledge.filter(
      (item) => item.kind === "repository" && (item.status === "cloning" || item.refreshing),
    );
    if (interrupted.length === 0) return;
    await this.withWrite(async () => {
      const nextState = structuredClone(this.state);
      const now = new Date().toISOString();
      let changed = false;
      for (const item of interrupted) {
        if (item.kind !== "repository") continue;
        const index = nextState.knowledge.findIndex((entry) => entry.id === item.id);
        const current = nextState.knowledge[index];
        if (current?.kind !== "repository") continue;
        if (current.refreshing) {
          nextState.knowledge[index] = KnowledgeItemSchema.parse({
            ...current,
            refreshing: false,
            refreshError:
              "The source refresh was interrupted by a server restart. The previous starting commit is still selected.",
            updatedAt: now,
          });
          changed = true;
          continue;
        }
        if (current.status !== "cloning") continue;
        const state = await inspectRepositoryDestinationKind(this.knowledgePath(current));
        const error =
          state === "git"
            ? "The clone was interrupted. The destination looks like an existing git clone; retry to verify and adopt it."
            : state === "occupied"
              ? "The clone was interrupted and left unknown files at its destination. Move or remove them, then retry the clone."
              : "The clone was interrupted by a server restart. Retry the clone to recover.";
        nextState.knowledge[index] = KnowledgeItemSchema.parse({
          ...current,
          status: "failed",
          error,
          updatedAt: now,
        });
        changed = true;
      }
      if (!changed) return;
      await this.writeState(nextState);
      this.state = nextState;
    });
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

export type RepositoryDestinationState = "missing" | "empty" | "git" | "occupied";

export async function inspectRepositoryDestinationKind(
  destination: string,
): Promise<RepositoryDestinationState> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(destination);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return "missing";
    throw error;
  }
  if (!entry.isDirectory()) return "occupied";
  const entries = await readdir(destination);
  if (entries.length === 0) return "empty";
  if (entries.includes(".git")) return "git";
  return "occupied";
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
    version: 7,
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
    slug: uniqueThreadSlug(
      name,
      threads.filter((thread) => thread.workspaceId === workspaceId),
    ),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastMessageAt: null,
    archived: false,
  });
}

function uniqueThreadSlug(name: string, threads: Thread[]): string {
  // Archived threads stay addressable by the same slug space, so renaming or creating a
  // thread can never silently reuse the deep link of an archived conversation.
  return uniqueSlug(name, threads);
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

// Reference artifacts keep the exact URL as identity; only the derived display label may
// exceed the 255-character ArtifactSchema bound, so truncate deterministically with an
// ellipsis. Short URLs keep their original label unchanged.
function artifactReferenceName(value: string, maxLength = 255): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, maxLength - 1).join("")}…`;
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

class InvalidUtf8PreviewError extends Error {}

interface BoundedPreview {
  sha256: string;
  text: string;
  redactionText: string;
  truncated: boolean;
}

async function hashAndBoundPreview(
  file: string,
  expectedHash?: string,
  redactionLookaheadBytes = PREVIEW_OVERREAD_BYTES,
): Promise<BoundedPreview> {
  const hash = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const retained: Buffer[] = [];
  let retainedBytes = 0;
  let totalReadBytes = 0;
  let invalidUtf8 = false;
  let overflow = false;
  const retainLimit = PREVIEW_BUDGET_BYTES + redactionLookaheadBytes;
  const tooLargeMessage = "Knowledge document file is too large.";
  let fileSize: number | undefined;
  try {
    fileSize = (await stat(file)).size;
    if (fileSize > MAX_UPLOAD_BYTES) {
      throw new StoreError("invalid", tooLargeMessage);
    }
    for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
      const remaining = MAX_UPLOAD_BYTES + 1 - totalReadBytes;
      if (remaining <= 0) {
        overflow = true;
        break;
      }
      const source = chunk as Buffer;
      const bytes = remaining < source.length ? source.subarray(0, remaining) : source;
      hash.update(bytes);
      if (!invalidUtf8) {
        try {
          decoder.decode(bytes, { stream: true });
        } catch {
          invalidUtf8 = true;
        }
      }
      totalReadBytes += bytes.length;
      if (totalReadBytes > MAX_UPLOAD_BYTES) {
        overflow = true;
        break;
      }
      if (retainedBytes < retainLimit) {
        const keep = bytes.subarray(0, retainLimit - retainedBytes);
        retained.push(keep);
        retainedBytes += keep.length;
      }
    }
    if (!invalidUtf8) {
      try {
        decoder.decode();
      } catch {
        invalidUtf8 = true;
      }
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new StoreError("invalid", "Knowledge document file is missing.");
    }
    throw error;
  }
  if (overflow) {
    throw new StoreError("invalid", tooLargeMessage);
  }
  const sha256 = hash.digest("hex");
  if (expectedHash && expectedHash !== sha256) {
    throw new StoreError("invalid", "Document revision content is corrupted.");
  }
  if (invalidUtf8) {
    throw new InvalidUtf8PreviewError();
  }
  const allRetained = Buffer.concat(retained);
  const previewBoundary = utf8SafeBoundary(
    allRetained.subarray(0, PREVIEW_BUDGET_BYTES),
    PREVIEW_BUDGET_BYTES,
  );
  const redactionEnd = Math.min(allRetained.length, PREVIEW_BUDGET_BYTES + redactionLookaheadBytes);
  const redactionBoundary = utf8SafeBoundary(allRetained.subarray(0, redactionEnd), redactionEnd);
  return {
    sha256,
    text: new TextDecoder("utf-8").decode(previewBoundary),
    redactionText: new TextDecoder("utf-8").decode(redactionBoundary),
    truncated: (fileSize ?? totalReadBytes) > PREVIEW_BUDGET_BYTES,
  };
}

function utf8SafeBoundary(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let end = Math.min(bytes.length, maxBytes);
  for (;;) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      return bytes.subarray(0, end);
    } catch {
      if (end === 0) return bytes.subarray(0, 0);
      end -= 1;
    }
  }
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type TranscriptFileScanStatus = "complete" | "missing" | "unreadable" | "limited";

interface TranscriptFileScanOutcome {
  status: TranscriptFileScanStatus;
  limitedBy?: "bytes" | "lines";
  bytesRead: number;
  lineCount: number;
}

class MessageSearchScanner {
  private readonly budgets: MessageSearchBudgets;
  private readonly term: string;
  private readonly windowSize: number;
  private readonly matches: MessageSearchHit[] = [];
  private matchesFound = 0;
  private linesRead = 0;
  private bytesRead = 0;
  private messageEventsSeen = 0;
  private malformedLines = 0;
  private tornTailLines = 0;
  private oversizedLines = 0;
  private missingFiles = 0;
  private unreadableFiles = 0;
  private threadsScanned = 0;
  private scanLimited = false;
  private scanLimit: MessageSearchDiagnostics["scanLimit"] = null;
  private complete = true;

  constructor(
    private readonly store: FileStore,
    private readonly input: MessageSearchRequest,
    budgets: MessageSearchBudgets,
  ) {
    this.budgets = budgets;
    this.term = input.q.toLowerCase();
    this.windowSize = input.offset + input.limit;
  }

  async scanThread(thread: Thread): Promise<void> {
    this.threadsScanned += 1;
    const emptyExpected = thread.messageCount === 0 && thread.lastMessageAt === null;
    const outcome = await scanTranscriptFile(
      this.store.transcriptPath(thread.id),
      Math.max(0, this.budgets.maxScanBytes - this.bytesRead),
      Math.max(0, this.budgets.maxScanLines - this.linesRead),
      this.budgets.maxLineBytes,
      (line) => this.handleLine(thread, line),
      () => this.handleOversizedLine(),
      (oversized) => this.handleTornTail(oversized),
      () => this.handleMalformedUtf8Line(),
    );
    this.bytesRead += outcome.bytesRead;
    this.linesRead += outcome.lineCount;
    if (outcome.status === "missing") {
      if (emptyExpected) return;
      this.missingFiles += 1;
      this.complete = false;
      this.scanLimit ??= "missing_file";
    } else if (outcome.status === "unreadable") {
      this.unreadableFiles += 1;
      this.complete = false;
      this.scanLimit ??= "unreadable_file";
    } else if (outcome.status === "limited") {
      this.scanLimited = true;
      this.complete = false;
      if (outcome.limitedBy) this.scanLimit ??= outcome.limitedBy;
    }
  }

  isScanLimited(): boolean {
    return this.scanLimited;
  }

  response(input: MessageSearchRequest): MessageSearchResponse {
    const complete = this.complete && !this.scanLimited;
    const pageEnd = input.offset + input.limit;
    const nextOffset =
      complete && this.matchesFound > pageEnd && pageEnd <= MESSAGE_SEARCH_MAX_OFFSET
        ? pageEnd
        : null;
    const diagnostics: MessageSearchDiagnostics = {
      threadsScanned: this.threadsScanned,
      linesRead: this.linesRead,
      bytesRead: this.bytesRead,
      messageEventsSeen: this.messageEventsSeen,
      malformedLines: this.malformedLines,
      tornTailLines: this.tornTailLines,
      oversizedLines: this.oversizedLines,
      missingFiles: this.missingFiles,
      unreadableFiles: this.unreadableFiles,
      scanLimited: this.scanLimited,
      scanLimit: this.scanLimit,
    };
    return MessageSearchResponseSchema.parse({
      query: {
        term: this.redactedTerm(),
        workspaceId: input.workspaceId,
        threadId: input.threadId ?? null,
        archived: input.archived,
      },
      matches: this.matches.slice(input.offset, pageEnd),
      matchesFound: this.matchesFound,
      complete,
      nextOffset,
      diagnostics,
    });
  }

  private redactedTerm(): string {
    const redacted = this.store.redactSecrets(this.input.q);
    return redacted.length > MESSAGE_SEARCH_QUERY_MAX_LENGTH
      ? redacted.slice(0, MESSAGE_SEARCH_QUERY_MAX_LENGTH)
      : redacted;
  }

  private handleLine(thread: Thread, line: string): void {
    if (!line.trim()) return;
    let event: TranscriptEvent | undefined;
    try {
      event = parseTranscriptEvent(line);
    } catch {
      this.malformedLines += 1;
      this.complete = false;
      return;
    }
    if (event?.type !== "message.created") return;
    this.messageEventsSeen += 1;
    const content = this.store.redactSecrets(event.message.content);
    if (!content.toLowerCase().includes(this.term)) return;
    const snippet = searchSnippet(content, this.term);
    const threadSummary = {
      id: thread.id,
      name: this.store.redactSecrets(thread.name),
      slug: this.store.redactSecrets(thread.slug),
      archived: thread.archived,
    };
    let hit: MessageSearchHit;
    try {
      const author: MessageSearchAuthor = MessageSearchAuthorSchema.parse({
        ...event.message.author,
        name: this.store.redactSecrets(event.message.author.name),
        ...(event.message.author.kind === "agent"
          ? { handle: this.store.redactSecrets(event.message.author.handle) }
          : {}),
      });
      hit = MessageSearchHitSchema.parse({
        messageId: event.message.id,
        sequence: event.message.sequence,
        thread: threadSummary,
        author,
        createdAt: event.message.createdAt,
        snippet,
      });
    } catch {
      // Never let a display/redaction parse failure escape the stream callback;
      // treat the rest of the scan as partial rather than crashing the request.
      this.complete = false;
      return;
    }
    this.insertMatch(hit);
  }

  private handleOversizedLine(): void {
    this.oversizedLines += 1;
    this.complete = false;
  }

  private handleMalformedUtf8Line(): void {
    this.malformedLines += 1;
    this.complete = false;
  }

  private handleTornTail(oversized: boolean): void {
    this.tornTailLines += 1;
    if (oversized) this.oversizedLines += 1;
    this.complete = false;
  }

  private insertMatch(hit: MessageSearchHit): void {
    this.matchesFound += 1;
    if (this.matches.length >= this.windowSize) {
      const last = this.matches[this.matches.length - 1];
      if (last && compareSearchHits(hit, last) >= 0) return;
      this.matches.pop();
    }
    const index = searchHitLowerBound(this.matches, hit);
    this.matches.splice(index, 0, hit);
  }
}

function compareSearchHits(left: MessageSearchHit, right: MessageSearchHit): number {
  const byTime = right.createdAt.localeCompare(left.createdAt);
  if (byTime !== 0) return byTime;
  const bySequence = right.sequence - left.sequence;
  if (bySequence !== 0) return bySequence;
  return left.messageId.localeCompare(right.messageId);
}

function searchHitLowerBound(hits: MessageSearchHit[], target: MessageSearchHit): number {
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const candidate = hits[mid];
    if (candidate && compareSearchHits(candidate, target) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}

function searchSnippet(content: string, term: string): string {
  const index = content.toLowerCase().indexOf(term);
  let snippet: string;
  if (index < 0) {
    snippet = content.slice(0, MESSAGE_SEARCH_SNIPPET_MAX_CHARS);
  } else {
    const contextBefore = Math.floor((MESSAGE_SEARCH_SNIPPET_MAX_CHARS - term.length) / 2);
    const contextAfter = MESSAGE_SEARCH_SNIPPET_MAX_CHARS - term.length - contextBefore;
    const start = Math.max(0, index - contextBefore);
    const end = Math.min(content.length, index + term.length + contextAfter);
    snippet = content.slice(start, end);
    if (start > 0) snippet = `\u2026${snippet}`;
    if (end < content.length) snippet = `${snippet}\u2026`;
    if (snippet.length > MESSAGE_SEARCH_SNIPPET_MAX_CHARS) {
      snippet = snippet.slice(0, MESSAGE_SEARCH_SNIPPET_MAX_CHARS);
    }
  }
  // Copy into a fresh string so a small snippet never keeps the whole line alive.
  return Buffer.from(snippet, "utf8").toString("utf8");
}

async function scanTranscriptFile(
  file: string,
  maxBytes: number,
  maxLines: number,
  maxLineBytes: number,
  onLine: (line: string) => void,
  onOversizedLine: () => void,
  onTornTail: (oversized: boolean) => void,
  onInvalidUtf8: () => void,
): Promise<TranscriptFileScanOutcome> {
  return new Promise((resolve) => {
    let bytesRead = 0;
    let lineCount = 0;
    let carry: Buffer | null = null;
    let carryLength = 0;
    let oversized = false;
    let lastByte = -1;
    let settled = false;
    const buffer = () => {
      if (carry === null) carry = Buffer.allocUnsafe(maxLineBytes);
      return carry;
    };
    const finish = (result: TranscriptFileScanOutcome): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve(result);
    };
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    stream.on("error", (error) => {
      if (isNodeError(error, "ENOENT")) {
        finish({ status: "missing", bytesRead, lineCount });
      } else {
        finish({ status: "unreadable", bytesRead, lineCount });
      }
    });
    stream.on("data", (chunk: Buffer) => {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBytes) {
        finish({ status: "limited", limitedBy: "bytes", bytesRead, lineCount });
        return;
      }
      let start = 0;
      while (start < chunk.byteLength) {
        const newlineIndex = chunk.indexOf(0x0a, start);
        if (newlineIndex === -1) {
          const remaining = chunk.subarray(start);
          if (!oversized) {
            const space = maxLineBytes - carryLength;
            if (remaining.byteLength > space) {
              remaining.copy(buffer(), carryLength, 0, space);
              carryLength = maxLineBytes;
              oversized = true;
            } else {
              remaining.copy(buffer(), carryLength);
              carryLength += remaining.byteLength;
            }
          }
          break;
        }
        const segment = chunk.subarray(start, newlineIndex);
        let isOversized = oversized;
        if (!isOversized) {
          const space = maxLineBytes - carryLength;
          if (segment.byteLength > space) {
            segment.copy(buffer(), carryLength, 0, space);
            carryLength = maxLineBytes;
            isOversized = true;
          } else {
            segment.copy(buffer(), carryLength);
            carryLength += segment.byteLength;
          }
        }
        lineCount += 1;
        if (lineCount > maxLines) {
          finish({ status: "limited", limitedBy: "lines", bytesRead, lineCount });
          return;
        }
        if (isOversized) {
          onOversizedLine();
        } else {
          try {
            const line = new TextDecoder("utf-8", { fatal: true }).decode(
              buffer().subarray(0, carryLength),
            );
            onLine(line);
          } catch {
            onInvalidUtf8();
          }
        }
        carryLength = 0;
        oversized = false;
        lastByte = 0x0a;
        start = newlineIndex + 1;
      }
      lastByte = chunk[chunk.byteLength - 1] ?? -1;
    });
    stream.on("end", () => {
      if (settled) return;
      if (lastByte !== 0x0a && (carryLength > 0 || oversized)) {
        onTornTail(oversized || carryLength >= maxLineBytes);
      }
      finish({ status: "complete", bytesRead, lineCount });
    });
  });
}

function stripTrailingNewline(line: string): string {
  return line.endsWith("\n") ? line.slice(0, -1) : line;
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

async function appendSynced(
  file: string,
  event: TranscriptEvent,
): Promise<{ baseOffset: number; endOffset: number }> {
  return appendManySynced(file, [event]);
}

async function appendManySynced(
  file: string,
  events: TranscriptEvent[],
): Promise<{ baseOffset: number; endOffset: number }> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "a", 0o600);
  try {
    const before = (await handle.stat()).size;
    await handle.appendFile(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    await handle.sync();
    const after = (await handle.stat()).size;
    return { baseOffset: before, endOffset: after };
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

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function transcriptIndexMaxSequence(index: TranscriptHistoryIndex): number {
  let highest = 0;
  for (const entry of index.messages) highest = Math.max(highest, entry.sequence);
  for (const entry of index.artifacts) highest = Math.max(highest, entry.sequence);
  for (const entry of index.runLatestByRunId.values()) highest = Math.max(highest, entry.sequence);
  for (const entry of index.toolById.values()) highest = Math.max(highest, entry.sequence);
  return highest;
}

function receiptKey(threadId: string, requestIdHash: string): string {
  return `${threadId}:${requestIdHash}`;
}

function normalizeRequestId(requestId: string): string {
  try {
    return MessageRequestIdSchema.parse(requestId);
  } catch {
    throw new StoreError("invalid", "requestId must be a UUID.");
  }
}

function hashRequestId(requestId: string): string {
  return createHash("sha256").update(requestId).digest("hex");
}

export function computeSubmissionFingerprint(
  content: string,
  uploads: UploadArtifactInput[],
): string {
  const payload = {
    version: 1,
    content: content.trim(),
    uploads: uploads.map((upload) => {
      const mediaType = normaliseMediaType(upload.mediaType) || inferMediaType(upload.name);
      return {
        name: normaliseArtifactName(upload.name),
        mediaType,
        size: upload.bytes.byteLength,
        sha256: hashBytes(upload.bytes),
      };
    }),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
export function keyedUploadStorageId(
  threadId: string,
  requestId: string,
  index: number,
  bytesHash: string,
): string {
  const digest = createHash("sha256")
    .update(
      threadId +
        String.fromCharCode(0) +
        requestId +
        String.fromCharCode(0) +
        index +
        String.fromCharCode(0) +
        bytesHash,
    )
    .digest("hex");
  return `sub-${digest.slice(0, 40)}`;
}

function prepareSubmissionUploadIds(
  threadId: string,
  requestId: string,
  uploads: UploadArtifactInput[],
): string[] {
  return uploads.map((upload, index) =>
    keyedUploadStorageId(threadId, requestId, index, hashBytes(upload.bytes)),
  );
}

function parseSubmissionEnvelope(value: unknown): UserSubmissionEnvelope | "invalid" | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "invalid";
  const envelope = value as Record<string, unknown>;
  if (
    typeof envelope.requestIdHash !== "string" ||
    typeof envelope.fingerprint !== "string" ||
    !isSubmissionHash(envelope.requestIdHash) ||
    !isSubmissionHash(envelope.fingerprint)
  ) {
    return "invalid";
  }
  const artifactPlan = parseSubmissionArtifactPlan(envelope.artifactPlan);
  if (artifactPlan === "invalid") return "invalid";
  return {
    requestIdHash: envelope.requestIdHash,
    fingerprint: envelope.fingerprint,
    ...(artifactPlan !== undefined ? { artifactPlan } : {}),
  };
}

function parseSubmissionArtifactPlan(
  value: unknown,
): UserSubmissionArtifactPlanEntry[] | "invalid" | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 40) return "invalid";
  const plan: UserSubmissionArtifactPlanEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "invalid";
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > 200 ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      entry.name.length > 255 ||
      (entry.kind !== "image" && entry.kind !== "file" && entry.kind !== "link") ||
      (entry.source !== "upload" && entry.source !== "reference") ||
      typeof entry.createdAt !== "string"
    ) {
      return "invalid";
    }
    if (
      (entry.mediaType !== undefined &&
        (typeof entry.mediaType !== "string" || entry.mediaType.length > 160)) ||
      (entry.size !== undefined &&
        (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0)) ||
      (entry.url !== undefined && (typeof entry.url !== "string" || entry.url.length > 4_096)) ||
      (entry.path !== undefined && (typeof entry.path !== "string" || entry.path.length > 1_024))
    ) {
      return "invalid";
    }
    plan.push({
      id: entry.id,
      kind: entry.kind,
      source: entry.source,
      name: entry.name,
      createdAt: entry.createdAt,
      ...(entry.mediaType !== undefined ? { mediaType: entry.mediaType } : {}),
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      ...(entry.path !== undefined ? { path: entry.path } : {}),
    });
  }
  return plan;
}
function isSubmissionHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function upsertSubmissionReceipt(
  receipts: Map<string, UserSubmissionReceipt>,
  threadId: string,
  envelope: UserSubmissionEnvelope,
  messageId: string,
  sequence: number,
  lineStart: number,
  lineEnd: number,
): boolean {
  const key = receiptKey(threadId, envelope.requestIdHash);
  const existing = receipts.get(key);
  if (existing) {
    const sameReceipt =
      existing.fingerprint === envelope.fingerprint &&
      existing.messageId === messageId &&
      existing.sequence === sequence &&
      existing.lineStart === lineStart &&
      existing.lineEnd === lineEnd;
    if (!sameReceipt) return false;
  }
  receipts.set(key, {
    requestIdHash: envelope.requestIdHash,
    fingerprint: envelope.fingerprint,
    messageId,
    sequence,
    lineStart,
    lineEnd,
  });
  return true;
}

async function writeKeyedUploadFile(
  file: string,
  bytes: Uint8Array,
): Promise<"created" | "reused"> {
  let existing: Buffer;
  try {
    existing = await readFile(file);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      await writePrivateFile(file, bytes);
      return "created";
    }
    throw error;
  }
  if (hashBytes(existing) !== hashBytes(bytes)) {
    throw new StoreError(
      "conflict",
      "A previously stored attachment for this request ID has different content.",
    );
  }
  return "reused";
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
    if (version === 7) return { state: StateSchema.parse(raw), needsWrite: false };
    if (version === 6) {
      const previous = VersionSixStateSchema.parse(raw);
      return {
        state: StateSchema.parse({
          ...previous,
          version: 7,
          tasks: previous.tasks.map((task) => ({
            ...task,
            verificationCommand: "",
          })),
          assignments: previous.assignments.map((assignment) => ({
            ...assignment,
          })),
        }),
        needsWrite: true,
      };
    }
    if (version === 5) {
      const previous = VersionFiveStateSchema.parse(raw);
      return {
        state: StateSchema.parse({
          ...previous,
          version: 7,
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
          version: 7,
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
          version: 7,
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
          version: 7,
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
        version: 7,
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
