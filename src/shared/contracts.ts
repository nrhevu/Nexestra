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
    provider: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("chatgpt"),
        model: z.string().trim().max(120).default(""),
      }),
      z.object({
        type: z.literal("custom"),
        name: z.string().trim().min(1).max(60),
        baseUrl: z.string().trim().url(),
        model: z.string().trim().min(1).max(160),
        protocol: z.enum(["openai-chat", "openai-responses"]),
        apiKey: z.string().max(4_096).optional(),
      }),
    ]),
  }),
]);
export type CreateAgentInput = z.input<typeof CreateAgentSchema>;

export const UpdateAgentSchema = z.object({
  enabled: z.boolean().optional(),
  archived: z.boolean().optional(),
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
});
export type Thread = z.infer<typeof ThreadSchema>;

export const CreateThreadSchema = z.object({
  workspaceId: z.string().optional(),
  name: z.string().trim().min(1).max(80),
});

export const MentionSchema = z.object({
  agentId: z.string(),
  handle: HandleSchema,
});

export const MessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sequence: z.number().int().positive(),
  author: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), id: z.literal("local-user"), name: z.string() }),
    z.object({
      kind: z.literal("agent"),
      id: z.string(),
      name: z.string(),
      handle: HandleSchema,
    }),
    z.object({ kind: z.literal("system"), id: z.literal("system"), name: z.string() }),
  ]),
  content: z.string(),
  mentions: z.array(MentionSchema),
  triggerMessageId: z.string().optional(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const CreateMessageSchema = z.object({
  content: z.string().trim().min(1).max(40_000),
});

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

export const HarnessToolNameSchema = z.enum([
  "list",
  "glob",
  "grep",
  "read",
  "edit",
  "write",
  "bash",
  "apply_patch",
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
  status: z.enum(["todo", "in_progress", "done"]),
  assigneeId: z.string().nullable(),
  threadId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskSchema = z.object({
  workspaceId: z.string().optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  assigneeId: z.string().nullable().default(null),
  threadId: z.string().nullable().default(null),
});

export const UpdateTaskSchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  assigneeId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
});

export interface RuntimeStatus {
  chatgpt: {
    installed: boolean;
    connected: boolean;
    message: string;
  };
  harnesses: Record<"codex" | "opencode", { installed: boolean; version: string | null }>;
}

export interface BootstrapData {
  workspaces: Workspace[];
  workspace: Workspace;
  agents: AgentView[];
  threads: Thread[];
  tasks: Task[];
  activeRuns: AgentRun[];
  runtime: RuntimeStatus;
  workspacePath: string;
  dataPath: string;
}

export interface ThreadData {
  thread: Thread;
  messages: Message[];
  runs: AgentRun[];
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
