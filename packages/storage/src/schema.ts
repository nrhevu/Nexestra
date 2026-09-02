import type {
  AcceptanceCriterion,
  Agent,
  Artifact,
  Decision,
  HarnessConfig,
  HarnessEventType,
  Memory,
  MemoryLinkType,
  MessageAttachment,
  MessageReference,
  MessageToolCall,
  NexestraEventType,
  OpenQuestion,
  PlanEdge,
  Run,
  Spec,
  Task,
  Thread,
  Usage,
  Workspace,
  WorkspaceSettings,
} from "@nexestra/core";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Drizzle schema. Every table is a projection rebuilt from `events`, except
 * `events` itself and `settings`.
 *
 * Conventions:
 * - ids and timestamps are text (ISO-8601), matching the zod domain schemas;
 * - anything the domain models as a nested object or array is a JSON column,
 *   so the row round-trips through the zod schema unchanged;
 * - booleans are integers (SQLite has no boolean).
 */

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

/** Roles the Anthropic Messages API accepts in a request's message list. */
export type MasterMessageRole = "user" | "assistant" | "system";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  rootPath: text("rootPath").notNull(),
  shortLabel: text("shortLabel").notNull(),
  defaultBranch: text("defaultBranch").notNull().default("main"),
  settings: json<WorkspaceSettings>("settings").notNull(),
  createdAt: text("createdAt").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull().default(""),
    harness: text("harness").notNull().$type<Agent["harness"]>(),
    providerId: text("providerId"),
    model: text("model"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("agents_workspace_idx").on(table.workspaceId, table.createdAt)],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    title: text("title").notNull(),
    phase: text("phase").notNull().$type<Thread["phase"]>(),
    summary: text("summary").notNull().default(""),
    agentId: text("agentId"),
    specId: text("specId"),
    planId: text("planId"),
    budgetUSD: real("budgetUSD").notNull().default(20),
    costUSD: real("costUSD").notNull().default(0),
    lastActivityAt: text("lastActivityAt").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("threads_workspace_idx").on(table.workspaceId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    role: text("role").notNull().$type<"user" | "master" | "system">(),
    content: text("content").notNull(),
    references: json<MessageReference[]>("references").notNull(),
    toolCalls: json<MessageToolCall[]>("toolCalls").notNull(),
    attachments: json<MessageAttachment[]>("attachments").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("messages_thread_idx").on(table.threadId, table.createdAt)],
);

export const specs = sqliteTable(
  "specs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    version: integer("version").notNull(),
    goal: text("goal").notNull(),
    scope: json<Spec["scope"]>("scope").notNull(),
    constraints: json<string[]>("constraints").notNull(),
    expectedOutcome: text("expectedOutcome").notNull().default(""),
    acceptanceCriteria: json<AcceptanceCriterion[]>("acceptanceCriteria").notNull(),
    openQuestions: json<OpenQuestion[]>("openQuestions").notNull(),
    decisions: json<Decision[]>("decisions").notNull(),
    frozen: integer("frozen", { mode: "boolean" }).notNull().default(false),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("specs_thread_idx").on(table.threadId)],
);

export const plans = sqliteTable(
  "plans",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    specId: text("specId").notNull(),
    version: integer("version").notNull(),
    summary: text("summary").notNull().default(""),
    taskIds: json<string[]>("taskIds").notNull(),
    edges: json<PlanEdge[]>("edges").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("plans_thread_idx").on(table.threadId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    planId: text("planId").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    dependsOn: json<string[]>("dependsOn").notNull(),
    agentId: text("agentId"),
    assignedHarness: text("assignedHarness").$type<Task["assignedHarness"]>(),
    harnessConfig: json<HarnessConfig>("harnessConfig").notNull(),
    status: text("status").notNull().$type<Task["status"]>(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("maxAttempts").notNull().default(3),
    acceptanceCriteriaIds: json<string[]>("acceptanceCriteriaIds").notNull(),
    costUSD: real("costUSD").notNull().default(0),
    mergeState: text("mergeState").$type<Task["mergeState"]>(),
    order: integer("order").notNull().default(0),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("tasks_thread_idx").on(table.threadId, table.order)],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    taskId: text("taskId").notNull(),
    kind: text("kind").notNull().$type<Run["kind"]>(),
    harness: text("harness").notNull().$type<Run["harness"]>(),
    sessionRef: text("sessionRef"),
    worktreePath: text("worktreePath"),
    status: text("status").notNull().$type<Run["status"]>(),
    exitCode: integer("exitCode"),
    usage: json<Usage>("usage").notNull(),
    startedAt: text("startedAt").notNull(),
    endedAt: text("endedAt"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("runs_thread_idx").on(table.threadId, table.startedAt)],
);

/** Normalised `HarnessEvent` rows, sequenced per run. */
export const runEvents = sqliteTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    runId: text("runId").notNull(),
    seq: integer("seq").notNull(),
    type: text("type").notNull().$type<HarnessEventType>(),
    payload: json<unknown>("payload").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [index("run_events_run_idx").on(table.runId, table.seq)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    taskId: text("taskId"),
    runId: text("runId"),
    kind: text("kind").notNull().$type<Artifact["kind"]>(),
    title: text("title").notNull(),
    path: text("path").notNull(),
    mimeType: text("mimeType").notNull().default("text/plain"),
    sizeBytes: integer("sizeBytes").notNull().default(0),
    preview: text("preview").notNull().default(""),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("artifacts_thread_idx").on(table.threadId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    taskId: text("taskId"),
    runId: text("runId"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    risk: text("risk").notNull().default("low").$type<"low" | "high">(),
    status: text("status").notNull(),
    requestedAt: text("requestedAt").notNull(),
    resolvedAt: text("resolvedAt"),
    resolvedBy: text("resolvedBy"),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("approvals_workspace_idx").on(table.workspaceId, table.status)],
);

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId"),
    type: text("type").notNull().$type<Memory["type"]>(),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    source: json<Memory["source"]>("source"),
    tags: json<string[]>("tags").notNull(),
    authoredBy: text("authoredBy").notNull().default("master").$type<"master" | "user">(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
  },
  (table) => [index("memories_workspace_idx").on(table.workspaceId)],
);

/**
 * Typed edges of the memory graph. `Memory.links` is hydrated from here on
 * read, so the graph has exactly one source of truth.
 */
export const memoryLinks = sqliteTable(
  "memory_links",
  {
    sourceId: text("sourceId").notNull(),
    targetId: text("targetId").notNull(),
    type: text("type").notNull().$type<MemoryLinkType>(),
    note: text("note").notNull().default(""),
    workspaceId: text("workspaceId").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.targetId, table.type] }),
    index("memory_links_target_idx").on(table.targetId),
  ],
);

/**
 * The append-only log. `seq` is monotonic per thread; workspace-level events
 * (`threadId` null) are sequenced per workspace instead.
 */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId"),
    runId: text("runId"),
    seq: integer("seq").notNull(),
    type: text("type").notNull().$type<NexestraEventType>(),
    payload: json<unknown>("payload").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [
    index("events_thread_seq_idx").on(table.threadId, table.seq),
    index("events_workspace_seq_idx").on(table.workspaceId, table.seq),
  ],
);

/**
 * The Master's raw conversation with the model, one row per message param
 * (M3). `content` holds the API content blocks **verbatim** — thinking blocks
 * with their signatures, compaction blocks, tool_use and tool_result — because
 * `@nexestra/master` replays them into the next request and extracting only
 * the text would break adaptive thinking continuity and server-side
 * compaction.
 *
 * This is the agent's working memory, not a projection: it is not rebuilt from
 * `events` and a thread replay leaves it alone. The user-visible transcript
 * lives in `messages`.
 */
export const masterMessages = sqliteTable(
  "master_messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspaceId").notNull(),
    threadId: text("threadId").notNull(),
    /** Monotonic per thread; the read order of the conversation. */
    seq: integer("seq").notNull(),
    role: text("role").notNull().$type<MasterMessageRole>(),
    content: json<unknown>("content").notNull(),
    createdAt: text("createdAt").notNull(),
  },
  (table) => [index("master_messages_thread_idx").on(table.threadId, table.seq)],
);

/** One row per thread: the serialised `MasterThreadState` (M3). */
export const masterState = sqliteTable("master_state", {
  threadId: text("threadId").primaryKey(),
  workspaceId: text("workspaceId").notNull(),
  state: json<unknown>("state").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

/** Machine-wide settings; a single row keyed `app`. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: text("updatedAt").notNull(),
});

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SpecRow = typeof specs.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunEventRow = typeof runEvents.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type MemoryLinkRow = typeof memoryLinks.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type MasterMessageRow = typeof masterMessages.$inferSelect;
export type MasterStateRow = typeof masterState.$inferSelect;

/** Every table a thread-scoped rebuild must clear before replaying. */
export const THREAD_SCOPED_TABLES = [
  messages,
  specs,
  plans,
  tasks,
  runs,
  runEvents,
  artifacts,
  approvals,
] as const;

export type { Workspace };
