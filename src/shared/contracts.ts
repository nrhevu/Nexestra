import { z } from "zod";

export const HandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{1,30}$/, "Use 2–31 characters: a-z, 0-9, _ or -.");

const AgentBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  handle: HandleSchema,
  description: z.string(),
  instructions: z.string(),
  enabled: z.boolean(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const WorkerAgentSchema = AgentBaseSchema.extend({
  kind: z.literal("worker"),
  harness: z.enum(["codex", "opencode"]),
});

export const MasterAgentSchema = AgentBaseSchema.extend({
  kind: z.literal("master"),
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
  name: z.string().trim().min(1).max(60),
  handle: HandleSchema,
  description: z.string().trim().max(240).default(""),
  instructions: z.string().trim().max(8_000).default(""),
});

export const CreateAgentSchema = z.discriminatedUnion("kind", [
  AgentInputBaseSchema.extend({
    kind: z.literal("worker"),
    harness: z.enum(["codex", "opencode"]),
  }),
  AgentInputBaseSchema.extend({
    kind: z.literal("master"),
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
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const CreateThreadSchema = z.object({
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
  status: z.enum(["queued", "running", "completed", "failed", "interrupted"]),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentRun = z.infer<typeof RunSchema>;

export const TaskSchema = z.object({
  id: z.string(),
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
