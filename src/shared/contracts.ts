import { z } from "zod";

export const HandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,30}$/, "Use 2–31 characters: a-z, 0-9, _ or -.");

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(60),
});

export const UpdateWorkspaceSchema = CreateWorkspaceSchema;

export const ReorderWorkspacesSchema = z.object({
  workspaceIds: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Include each workspace exactly once.",
    }),
});

export const KnowledgeHandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,47}$/, "Use 2–48 characters: a-z, 0-9, _ or -.");

export const KNOWLEDGE_BRANCH_NAME_MAX_LENGTH = 256;
export const KNOWLEDGE_BRANCH_LIST_MAX_ROWS = 500;

const KnowledgeBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  handle: KnowledgeHandleSchema,
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const KnowledgeDocumentSchema = KnowledgeBaseSchema.extend({
  kind: z.literal("document"),
  fileName: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  storagePath: z.string(),
  revisions: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        fileName: z.string(),
        mediaType: z.string(),
        size: z.number().int().nonnegative(),
        storagePath: z.string(),
        sha256: z.string(),
        restoredFromId: z.string().optional(),
      }),
    )
    .default([]),
  currentRevisionId: z.string().optional(),
});

export const KnowledgeRepositorySchema = KnowledgeBaseSchema.extend({
  kind: z.literal("repository"),
  source: z.string(),
  storagePath: z.string(),
  defaultBranch: z.string().optional(),
  selectedBranch: z.string().trim().min(1).max(KNOWLEDGE_BRANCH_NAME_MAX_LENGTH).optional(),
  sourceVersion: z.number().int().nonnegative().optional(),
  sourceCommit: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .optional(),
  sourceRef: z.string().optional(),
  refreshedAt: z.string().optional(),
  refreshing: z.boolean().optional(),
  refreshError: z.string().optional(),
  status: z.enum(["cloning", "ready", "failed"]),
  error: z.string().optional(),
});

export const KnowledgeRepositoryBranchSchema = z.object({
  name: z.string().trim().min(1).max(KNOWLEDGE_BRANCH_NAME_MAX_LENGTH),
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type KnowledgeRepositoryBranch = z.infer<typeof KnowledgeRepositoryBranchSchema>;

export const KnowledgeRepositoryBranchesResponseSchema = z.object({
  branches: z.array(KnowledgeRepositoryBranchSchema).max(KNOWLEDGE_BRANCH_LIST_MAX_ROWS),
  truncated: z.boolean(),
  sourceVersion: z.number().int().nonnegative(),
  selectedBranch: z.string().trim().min(1).max(KNOWLEDGE_BRANCH_NAME_MAX_LENGTH).nullable(),
  defaultBranch: z.string().trim().min(1).max(KNOWLEDGE_BRANCH_NAME_MAX_LENGTH).nullable(),
});
export type KnowledgeRepositoryBranchesResponse = z.infer<
  typeof KnowledgeRepositoryBranchesResponseSchema
>;

export const SelectRepositorySourceBranchSchema = z.object({
  branch: z.string().trim().min(1).max(KNOWLEDGE_BRANCH_NAME_MAX_LENGTH),
  expectedSourceVersion: z.number().int().nonnegative(),
});
export type SelectRepositorySourceBranchInput = z.infer<typeof SelectRepositorySourceBranchSchema>;

export const KnowledgeItemSchema = z.discriminatedUnion("kind", [
  KnowledgeDocumentSchema,
  KnowledgeRepositorySchema,
]);
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;
export type KnowledgeRepository = z.infer<typeof KnowledgeRepositorySchema>;

export const CreateKnowledgeDocumentSchema = z.object({
  workspaceId: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  handle: KnowledgeHandleSchema,
  description: z.string().trim().max(1_000).default(""),
});

export const ReplaceKnowledgeDocumentSchema = z.object({
  expectedRevisionId: z.string().trim().min(1),
});

export const RestoreKnowledgeDocumentRevisionSchema = z.object({
  expectedRevisionId: z.string().trim().min(1),
});

export const CreateKnowledgeRepositorySchema = z.object({
  workspaceId: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  handle: KnowledgeHandleSchema,
  description: z.string().trim().max(1_000).default(""),
  source: z.string().trim().min(1).max(2_048),
});

export const UpdateKnowledgeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  handle: KnowledgeHandleSchema.optional(),
  description: z.string().trim().max(1_000).optional(),
});

const AgentBaseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  handle: HandleSchema,
  description: z.string(),
  instructions: z.string(),
  enabled: z.boolean(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const WorkerModelSchema = z.string().trim().min(1).max(160);
const WorkerReasoningEffortSchema = z.string().trim().min(1).max(40);

export const ToolPermissionSchema = z.enum(["allow", "ask", "deny"]);
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

export const MasterAccessModeSchema = z.enum(["ask", "auto", "full"]);
export type MasterAccessMode = z.infer<typeof MasterAccessModeSchema>;

export const WorkerAgentSchema = AgentBaseSchema.extend({
  kind: z.literal("worker"),
  harness: z.enum(["codex", "opencode"]),
  model: WorkerModelSchema.optional(),
  reasoningEffort: WorkerReasoningEffortSchema.optional(),
});

export const MasterAgentSchema = AgentBaseSchema.extend({
  kind: z.literal("master"),
  accessMode: MasterAccessModeSchema,
  provider: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("chatgpt"),
      model: z.string(),
    }),
    z.object({
      type: z.literal("custom"),
      name: z.string(),
      baseUrl: z.string().url(),
      model: z.string(),
      protocol: z.enum(["openai-chat", "openai-responses"]),
      hasCredential: z.boolean(),
    }),
  ]),
});

export const AgentSchema = z.discriminatedUnion("kind", [WorkerAgentSchema, MasterAgentSchema]);
export type Agent = z.infer<typeof AgentSchema>;
export type WorkerAgent = z.infer<typeof WorkerAgentSchema>;
export type MasterAgent = z.infer<typeof MasterAgentSchema>;

const AgentInputBaseSchema = z.object({
  workspaceId: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  handle: HandleSchema,
  description: z.string().trim().max(240).default(""),
  instructions: z.string().trim().max(8_000).default(""),
});

const ChatGptProviderInputSchema = z.object({
  type: z.literal("chatgpt"),
  model: z.string().trim().max(120).default(""),
});

const CustomProviderInputSchema = z.object({
  type: z.literal("custom"),
  name: z.string().trim().min(1).max(60),
  baseUrl: z.string().trim().url(),
  model: z.string().trim().min(1).max(160),
  protocol: z.enum(["openai-chat", "openai-responses"]),
  apiKey: z
    .string()
    .trim()
    .max(4_096)
    .refine((value) => value.length === 0 || value.length >= 8, {
      message: "API key must be blank or at least 8 characters.",
    })
    .optional(),
});

export const CreateAgentSchema = z.discriminatedUnion("kind", [
  AgentInputBaseSchema.extend({
    kind: z.literal("worker"),
    harness: z.enum(["codex", "opencode"]),
    model: WorkerModelSchema.optional(),
    reasoningEffort: WorkerReasoningEffortSchema.optional(),
  }),
  AgentInputBaseSchema.extend({
    kind: z.literal("master"),
    accessMode: MasterAccessModeSchema.default("ask"),
    provider: z.discriminatedUnion("type", [ChatGptProviderInputSchema, CustomProviderInputSchema]),
  }),
]);
export type CreateAgentInput = z.input<typeof CreateAgentSchema>;

export const UpdateAgentSchema = z.strictObject({
  enabled: z.boolean().optional(),
  archived: z.boolean().optional(),
  name: AgentInputBaseSchema.shape.name.optional(),
  handle: HandleSchema.optional(),
  description: z.string().trim().max(240).optional(),
  instructions: z.string().trim().max(8_000).optional(),
  harness: z.enum(["codex", "opencode"]).optional(),
  model: WorkerModelSchema.nullable().optional(),
  reasoningEffort: WorkerReasoningEffortSchema.nullable().optional(),
  accessMode: MasterAccessModeSchema.optional(),
  provider: z
    .discriminatedUnion("type", [
      ChatGptProviderInputSchema,
      CustomProviderInputSchema.extend({ removeCredential: z.boolean().optional() }).refine(
        (provider) => !(provider.removeCredential && provider.apiKey),
        { message: "Choose either a new API key or Remove credential." },
      ),
    ])
    .optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;

export type AgentReadiness = "ready" | "busy" | "needs_setup" | "unavailable" | "disabled";

export type AgentView = Agent & {
  readiness: AgentReadiness;
  readinessLabel: string;
};

export const ThreadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
  // Default keeps legacy state files and fixtures readable without a version bump.
  archived: z.boolean().default(false),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const CreateThreadSchema = z.object({
  workspaceId: z.string().optional(),
  name: z.string().trim().min(1).max(80),
});

export const RenameThreadSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const MentionSchema = z.object({
  agentId: z.string(),
  handle: HandleSchema,
});

export const KnowledgeReferenceSchema = z.object({
  knowledgeId: z.string(),
  handle: KnowledgeHandleSchema,
  revisionId: z.string().optional(),
});
export type KnowledgeReference = z.infer<typeof KnowledgeReferenceSchema>;

export const KnowledgeDocumentRevisionsSchema = z.object({
  currentRevisionId: z.string().optional(),
  revisions: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.string(),
        fileName: z.string(),
        mediaType: z.string(),
        size: z.number().int().nonnegative(),
        storagePath: z.string(),
        sha256: z.string(),
        restoredFromId: z.string().optional(),
      }),
    )
    .default([]),
});
export type KnowledgeDocumentRevisions = z.infer<typeof KnowledgeDocumentRevisionsSchema>;

export const KnowledgeDocumentPreviewSchema = z.object({
  revisionId: z.string().optional(),
  isCurrent: z.boolean(),
  fileName: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().optional(),
  createdAt: z.string().optional(),
  supported: z.boolean(),
  text: z.string().optional(),
  truncated: z.boolean(),
  reason: z.string().optional(),
});
export type KnowledgeDocumentPreview = z.infer<typeof KnowledgeDocumentPreviewSchema>;

export const MessageAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.literal("local-user"), name: z.string() }),
  z.object({
    kind: z.literal("agent"),
    id: z.string(),
    name: z.string(),
    handle: HandleSchema,
  }),
  z.object({ kind: z.literal("system"), id: z.literal("system"), name: z.string() }),
]);

export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sequence: z.number().int().positive(),
  author: MessageAuthorSchema,
  content: z.string(),
  mentions: z.array(MentionSchema),
  knowledgeReferences: z.array(KnowledgeReferenceSchema).max(40).default([]),
  artifactIds: z.array(z.string()).max(40).default([]),
  triggerMessageId: z.string().optional(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const CreateMessageSchema = z.object({
  content: z.string().trim().max(40_000),
});

export const MESSAGE_SEARCH_QUERY_MAX_LENGTH = 200;
export const MESSAGE_SEARCH_MAX_OFFSET = 10_000;

export const MESSAGE_SEARCH_SNIPPET_MAX_CHARS = 300;

export const MessageSearchArchivedFilterSchema = z.enum(["all", "active", "archived"]);
export type MessageSearchArchivedFilter = z.infer<typeof MessageSearchArchivedFilterSchema>;

export const MessageSearchRequestSchema = z.object({
  workspaceId: z.string().trim().min(1),
  q: z.string().trim().min(1).max(MESSAGE_SEARCH_QUERY_MAX_LENGTH),
  threadId: z.string().trim().min(1).optional(),
  archived: MessageSearchArchivedFilterSchema.default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(MESSAGE_SEARCH_MAX_OFFSET).default(0),
});
export type MessageSearchRequest = z.infer<typeof MessageSearchRequestSchema>;

export const MessageSearchDiagnosticsSchema = z.object({
  threadsScanned: z.number().int().nonnegative(),
  linesRead: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  messageEventsSeen: z.number().int().nonnegative(),
  malformedLines: z.number().int().nonnegative(),
  tornTailLines: z.number().int().nonnegative(),
  oversizedLines: z.number().int().nonnegative(),
  missingFiles: z.number().int().nonnegative(),
  unreadableFiles: z.number().int().nonnegative(),
  scanLimited: z.boolean(),
  scanLimit: z
    .enum(["bytes", "lines", "per_line", "threads", "missing_file", "unreadable_file"])
    .nullable(),
});
export type MessageSearchDiagnostics = z.infer<typeof MessageSearchDiagnosticsSchema>;

// Search echo schema: accepts redacted display fields without re-validating
// against handle/name constraints (a credential in a handle becomes
// "[REDACTED]" which must not fail parsing inside the stream callback).
export const MessageSearchAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.literal("local-user"), name: z.string().max(512) }),
  z.object({
    kind: z.literal("agent"),
    id: z.string().max(200),
    name: z.string().max(512),
    handle: z.string().max(512),
  }),
  z.object({ kind: z.literal("system"), id: z.literal("system"), name: z.string().max(512) }),
]);
export type MessageSearchAuthor = z.infer<typeof MessageSearchAuthorSchema>;

export const MessageSearchHitSchema = z.object({
  messageId: z.string().min(1).max(200),
  sequence: z.number().int().positive(),
  thread: z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(512),
    slug: z.string().min(1).max(512),
    archived: z.boolean(),
  }),
  author: MessageSearchAuthorSchema,
  createdAt: z.string().datetime({ offset: true }).max(40),
  snippet: z.string().max(MESSAGE_SEARCH_SNIPPET_MAX_CHARS),
});
export type MessageSearchHit = z.infer<typeof MessageSearchHitSchema>;

export const MessageSearchResponseSchema = z.object({
  query: z.object({
    // Echoed term is redacted and clipped; it never contains a stored credential.
    term: z.string().trim().min(1).max(MESSAGE_SEARCH_QUERY_MAX_LENGTH),
    workspaceId: z.string(),
    threadId: z.string().nullable(),
    archived: MessageSearchArchivedFilterSchema,
  }),
  matches: z.array(MessageSearchHitSchema),
  // Observed matches inside the scanned region; not a global total when complete is false.
  matchesFound: z.number().int().nonnegative(),
  complete: z.boolean(),
  // Present only when complete is true and more matches remain after this page.
  nextOffset: z.number().int().min(1).nullable(),
  diagnostics: MessageSearchDiagnosticsSchema,
});
export type MessageSearchResponse = z.infer<typeof MessageSearchResponseSchema>;

const ArtifactUrlSchema = z
  .string()
  .url()
  .max(4_096)
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Artifact links must use HTTP or HTTPS.",
  });

export const ArtifactSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  messageId: z.string(),
  sequence: z.number().int().positive(),
  kind: z.enum(["file", "image", "link"]),
  source: z.enum(["upload", "reference"]),
  name: z.string().trim().min(1).max(255),
  mediaType: z.string().trim().max(160).optional(),
  size: z.number().int().nonnegative().optional(),
  url: ArtifactUrlSchema.optional(),
  path: z.string().trim().max(1_024).optional(),
  createdAt: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const RunSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  triggerMessageId: z.string(),
  agentId: z.string(),
  attempt: z.number().int().positive(),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "waiting_input",
    "completed",
    "failed",
    "interrupted",
  ]),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentRun = z.infer<typeof RunSchema>;

export const RunActivitySchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  agentId: z.string(),
  stage: z.enum(["queued", "thinking", "tool", "responding"]),
  thinking: z.string().max(40_000),
  text: z.string().max(40_000),
  detail: z.string().max(500),
  updatedAt: z.string(),
});
export type RunActivity = z.infer<typeof RunActivitySchema>;

export interface ThreadStreamEvent {
  revision: number;
  refresh: boolean;
  activities: RunActivity[];
}

export const HarnessToolNameSchema = z.enum([
  "list",
  "glob",
  "grep",
  "read",
  "edit",
  "write",
  "bash",
  "apply_patch",
  "plan",
  "delegate",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "question",
]);
export type HarnessToolName = z.infer<typeof HarnessToolNameSchema>;

export const HarnessPermissionKeySchema = z.enum([
  "read",
  "edit",
  "bash",
  "skill",
  "todowrite",
  "webfetch",
  "websearch",
  "question",
  "external",
]);
export type HarnessPermissionKey = z.infer<typeof HarnessPermissionKeySchema>;

export const ToolQuestionSchema = z.object({
  header: z.string().trim().min(1).max(30),
  question: z.string().trim().min(1).max(500),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        description: z.string().trim().max(300).default(""),
      }),
    )
    .min(1)
    .max(12),
  multiple: z.boolean().default(false),
});
export type ToolQuestion = z.infer<typeof ToolQuestionSchema>;

export const ToolAnswersSchema = z.object({
  answers: z
    .array(z.array(z.string().trim().min(1).max(500)).min(1).max(12))
    .min(1)
    .max(3),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  runId: z.string(),
  threadId: z.string(),
  agentId: z.string(),
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  permission: HarnessPermissionKeySchema,
  status: z.enum([
    "waiting_approval",
    "waiting_input",
    "running",
    "completed",
    "denied",
    "failed",
    "interrupted",
  ]),
  input: z.string().max(4_000),
  questions: z.array(ToolQuestionSchema).min(1).max(3).optional(),
  answers: z
    .array(z.array(z.string().max(500)).max(12))
    .max(3)
    .optional(),
  summary: z.string().max(500).optional(),
  error: z.string().max(2_000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(["todo", "in_progress", "blocked", "done"]),
  assigneeId: z.string().nullable(),
  threadId: z.string().nullable(),
  verificationCommand: z.string().trim().max(2_000).default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const WorkAssignmentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
  threadId: z.string(),
  masterRunId: z.string(),
  workerAgentId: z.string(),
  repositoryId: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "interrupted"]),
  branch: z.string(),
  worktreePath: z.string(),
  baseCommit: z.string().trim().min(1).optional(),
  result: z.string().max(20_000).optional(),
  error: z.string().max(2_000).optional(),
  verificationOutput: z.string().max(4_000).optional(),
  verificationExitCode: z.number().int().optional(),
  worktreeCleanedAt: z.string().optional(),
  branchDeletedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkAssignment = z.infer<typeof WorkAssignmentSchema>;

export type AssignmentGitReviewState =
  | "pending"
  | "available"
  | "missing"
  | "cleaned"
  | "legacy"
  | "unavailable"
  | "unsafe";

export interface GitFileSummary {
  path: string;
  insertions: number | null;
  deletions: number | null;
}

export interface AssignmentGitTrackedSummary {
  files: GitFileSummary[];
  insertions: number;
  deletions: number;
  truncated: boolean;
}

export interface AssignmentGitPatch {
  content: string;
  truncated: boolean;
  binaryPaths: string[];
}

export interface AssignmentGitReview {
  assignment: WorkAssignment;
  state: AssignmentGitReviewState;
  reason?: string;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  headCommit?: string;
  tracked?: {
    baseToWorktree: AssignmentGitTrackedSummary;
    committed: AssignmentGitTrackedSummary;
    patch: AssignmentGitPatch;
    staged: AssignmentGitTrackedSummary;
    unstaged: AssignmentGitTrackedSummary;
  };
  untracked?: {
    files: string[];
    truncated: boolean;
  };
}

export const DelegateTaskSchema = z.object({
  workerHandle: HandleSchema,
  repositoryHandle: HandleSchema,
});

export const CreateTaskSchema = z.object({
  workspaceId: z.string().optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).default("todo"),
  assigneeId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
  verificationCommand: z.string().trim().max(2_000).default(""),
});

export const UpdateTaskSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2_000).optional(),
  status: z.enum(["todo", "in_progress", "blocked", "done"]).optional(),
  assigneeId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  verificationCommand: z.string().trim().max(2_000).optional(),
});

export interface RuntimeStatus {
  chatgpt: {
    installed: boolean;
    connected: boolean;
    message: string;
  };
  harnesses: Record<"codex" | "opencode", { installed: boolean; version: string | null }>;
}

export interface AttentionItem {
  id: string;
  kind: "approval" | "input" | "task_blocked" | "task_failed" | "task_interrupted";
  title: string;
  detail: string;
  threadId?: string;
  runId?: string;
  taskId?: string;
  updatedAt: string;
}

export interface WorkspaceActivityData {
  workspaceId: string;
  activeRuns: AgentRun[];
  attention: AttentionItem[];
}

export function compareAttentionItems(left: AttentionItem, right: AttentionItem): number {
  const leftGroup = left.kind === "approval" || left.kind === "input" ? 0 : 1;
  const rightGroup = right.kind === "approval" || right.kind === "input" ? 0 : 1;
  return (
    leftGroup - rightGroup ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

export function runAttentionItem(
  run: AgentRun,
  agentName: string,
  threadName: string,
): AttentionItem | undefined {
  if (run.status !== "waiting_approval" && run.status !== "waiting_input") return undefined;
  return {
    id: `run:${run.id}`,
    kind: run.status === "waiting_approval" ? "approval" : "input",
    title: `${agentName} in #${threadName}`,
    detail:
      run.status === "waiting_approval"
        ? "Approve or deny the pending tool request to continue."
        : "Answer the pending question to continue.",
    threadId: run.threadId,
    runId: run.id,
    updatedAt: run.updatedAt,
  };
}

export interface BootstrapData {
  workspaces: Workspace[];
  workspace: Workspace;
  agents: AgentView[];
  threads: Thread[];
  tasks: Task[];
  knowledge: KnowledgeItem[];
  assignments: WorkAssignment[];
  activeRuns: AgentRun[];
  attention: AttentionItem[];
  runtime: RuntimeStatus;
  workspacePath: string;
  dataPath: string;
}

export interface ThreadData {
  thread: Thread;
  messages: Message[];
  artifacts: Artifact[];
  runs: AgentRun[];
  toolCalls: ToolCall[];
}

export interface TaskProcessData {
  task: Task;
  assignment?: WorkAssignment;
  assignments: WorkAssignment[];
  run?: AgentRun;
  activity?: RunActivity;
  toolCalls: ToolCall[];
}

export function extractMentionHandles(content: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  const pattern = /(^|[^a-zA-Z0-9_-])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,30})/g;
  for (const match of content.matchAll(pattern)) {
    const handle = match[2]?.toLowerCase();
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
  }
  return handles;
}

export function extractKnowledgeHandles(content: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  const withoutCode = content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
  const pattern = /(^|[^a-zA-Z0-9_-])#([a-zA-Z0-9][a-zA-Z0-9_-]{1,47})/g;
  for (const match of withoutCode.matchAll(pattern)) {
    const handle = match[2]?.toLowerCase();
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
  }
  return handles;
}

export function handleFromName(name: string): string {
  const ascii = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\u0111/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31);
  const safe = ascii.length >= 2 ? ascii : `agent-${ascii || "new"}`;
  return safe.slice(0, 31);
}

export const THREAD_HISTORY_DEFAULT_LIMIT = 50;
export const THREAD_HISTORY_MAX_LIMIT = 100;

export const ThreadHistoryRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(THREAD_HISTORY_MAX_LIMIT)
      .default(THREAD_HISTORY_DEFAULT_LIMIT),
    before: z.string().trim().min(1).max(200).optional(),
    after: z.string().trim().min(1).max(200).optional(),
    around: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (value) =>
      [value.before, value.after, value.around].filter((id): id is string => id !== undefined)
        .length <= 1,
    { message: "Use at most one of before, after, or around." },
  );
export type ThreadHistoryRequest = z.infer<typeof ThreadHistoryRequestSchema>;

export const ThreadHistoryPageSchema = z.object({
  thread: ThreadSchema,
  messages: z.array(MessageSchema),
  artifacts: z.array(ArtifactSchema),
  runs: z.array(RunSchema),
  toolCalls: z.array(ToolCallSchema),
  activeRuns: z.array(RunSchema),
  page: z.object({
    totalMessages: z.number().int().nonnegative(),
    totalArtifacts: z.number().int().nonnegative(),
    firstMessageIndex: z.number().int().nonnegative(),
    lastMessageIndex: z.number().int().nonnegative(),
    beforeCursor: z.string().nullable(),
    afterCursor: z.string().nullable(),
    targetMessageId: z.string().optional(),
    targetFound: z.boolean().optional(),
  }),
});
export type ThreadHistoryPage = z.infer<typeof ThreadHistoryPageSchema>;

export const ThreadMetadataResponseSchema = ThreadSchema;
export type ThreadMetadataResponse = Thread;
