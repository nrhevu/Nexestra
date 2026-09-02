import {
  ApiErrorSchema,
  type Approval,
  ApprovalSchema,
  type AppSettings,
  AppSettingsSchema,
  type Artifact,
  ArtifactContentSchema,
  ArtifactSchema,
  type CreateMemoryRequest,
  type CreateMessageRequest,
  type CreateThreadRequest,
  type CreateWorkspaceRequest,
  type FileContent,
  FileContentSchema,
  type FileNode,
  FileNodeSchema,
  type HarnessInfo,
  HarnessInfoSchema,
  type Memory,
  MemorySchema,
  type Message,
  MessageSchema,
  type NexestraEvent,
  type Plan,
  PlanSchema,
  type Run,
  type RunEvent,
  RunEventSchema,
  RunSchema,
  type Spec,
  SpecSchema,
  type Task,
  TaskSchema,
  type TaskStatus,
  type Thread,
  ThreadSchema,
  type UpdateMemoryRequest,
  type UpdateTaskRequest,
  type UpdateThreadRequest,
  type Workspace,
  WorkspaceSchema,
} from "@nexestra/core";
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";

/** In dev, Vite proxies `/api` to the Hono server. */
const API_BASE = "/api";

const STALE = 30_000;

/** One place every query key is built, so cache updates cannot drift. */
export const keys = {
  workspaces: () => ["workspaces"] as const,
  threads: (workspaceId: string) => ["threads", workspaceId] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
  messages: (threadId: string) => ["messages", threadId] as const,
  spec: (threadId: string) => ["spec", threadId] as const,
  plan: (threadId: string) => ["plan", threadId] as const,
  tasks: (threadId: string) => ["tasks", threadId] as const,
  runs: (threadId: string) => ["runs", threadId] as const,
  runEvents: (runId: string) => ["runEvents", runId] as const,
  artifacts: (threadId: string) => ["artifacts", threadId] as const,
  memories: (workspaceId: string) => ["memories", workspaceId] as const,
  approvals: (workspaceId: string) => ["approvals", workspaceId] as const,
  settings: () => ["settings"] as const,
  files: () => ["files"] as const,
  file: (path: string) => ["file", path] as const,
  terminal: () => ["terminal"] as const,
  harnesses: () => ["harnesses"] as const,
};

/** An `/api/*` failure, carrying the server's error code for the UI. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method: string; json?: unknown },
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers:
      init?.json === undefined
        ? { accept: "application/json" }
        : { accept: "application/json", "content-type": "application/json" },
    body: init?.json === undefined ? undefined : JSON.stringify(init.json),
  });

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(await response.json().catch(() => null));
    throw parsed.success
      ? new ApiRequestError(
          response.status,
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error.details,
        )
      : new ApiRequestError(response.status, "internal", `${path} → HTTP ${response.status}`);
  }

  if (response.status === 204) return schema.parse(undefined);
  return schema.parse(await response.json());
}

const getJson = <T>(path: string, schema: z.ZodType<T>) => request(path, schema);

const query = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
};

// ------------------------------------------------------------------ queries

export function useWorkspaces(): UseQueryResult<Workspace[]> {
  return useQuery({
    queryKey: keys.workspaces(),
    queryFn: () => getJson("/workspaces", z.array(WorkspaceSchema)),
    staleTime: STALE,
  });
}

export function useThreads(workspaceId: string): UseQueryResult<Thread[]> {
  return useQuery({
    queryKey: keys.threads(workspaceId),
    queryFn: () => getJson(`/threads${query({ workspaceId })}`, z.array(ThreadSchema)),
    enabled: workspaceId.length > 0,
    staleTime: STALE,
  });
}

export function useMessages(threadId: string): UseQueryResult<Message[]> {
  return useQuery({
    queryKey: keys.messages(threadId),
    queryFn: () => getJson(`/threads/${threadId}/messages`, z.array(MessageSchema)),
    staleTime: STALE,
  });
}

export function useSpec(threadId: string): UseQueryResult<Spec | null> {
  return useQuery({
    queryKey: keys.spec(threadId),
    queryFn: () => getJson(`/threads/${threadId}/spec`, SpecSchema.nullable()),
    staleTime: STALE,
  });
}

export function usePlan(threadId: string): UseQueryResult<Plan | null> {
  return useQuery({
    queryKey: keys.plan(threadId),
    queryFn: () => getJson(`/threads/${threadId}/plan`, PlanSchema.nullable()),
    staleTime: STALE,
  });
}

export function useTasks(threadId: string): UseQueryResult<Task[]> {
  return useQuery({
    queryKey: keys.tasks(threadId),
    queryFn: () => getJson(`/tasks${query({ threadId })}`, z.array(TaskSchema)),
    staleTime: STALE,
  });
}

export function useRuns(threadId: string): UseQueryResult<Run[]> {
  return useQuery({
    queryKey: keys.runs(threadId),
    queryFn: () => getJson(`/runs${query({ threadId })}`, z.array(RunSchema)),
    staleTime: STALE,
  });
}

export function useRunEvents(runId: string | undefined): UseQueryResult<RunEvent[]> {
  return useQuery({
    queryKey: keys.runEvents(runId ?? ""),
    queryFn: () => getJson(`/runs/${runId}/events`, z.array(RunEventSchema)),
    enabled: Boolean(runId),
    staleTime: STALE,
  });
}

export function useArtifacts(threadId: string): UseQueryResult<Artifact[]> {
  return useQuery({
    queryKey: keys.artifacts(threadId),
    queryFn: () => getJson(`/artifacts${query({ threadId })}`, z.array(ArtifactSchema)),
    staleTime: STALE,
  });
}

export function useMemories(workspaceId: string): UseQueryResult<Memory[]> {
  return useQuery({
    queryKey: keys.memories(workspaceId),
    queryFn: () => getJson(`/memories${query({ workspaceId })}`, z.array(MemorySchema)),
    enabled: workspaceId.length > 0,
    staleTime: STALE,
  });
}

export function useApprovals(workspaceId: string): UseQueryResult<Approval[]> {
  return useQuery({
    queryKey: keys.approvals(workspaceId),
    queryFn: () => getJson(`/approvals${query({ workspaceId })}`, z.array(ApprovalSchema)),
    enabled: workspaceId.length > 0,
    staleTime: STALE,
  });
}

export function useSettings(): UseQueryResult<AppSettings> {
  return useQuery({
    queryKey: keys.settings(),
    queryFn: () => getJson("/settings", AppSettingsSchema),
    staleTime: STALE,
  });
}

export function useFileTree(): UseQueryResult<FileNode[]> {
  return useQuery({
    queryKey: keys.files(),
    queryFn: () => getJson("/files", z.array(FileNodeSchema)),
    staleTime: STALE,
  });
}

export function useFileContent(path: string): UseQueryResult<FileContent> {
  return useQuery({
    queryKey: keys.file(path),
    queryFn: () => getJson(`/files/content${query({ path })}`, FileContentSchema),
    staleTime: STALE,
  });
}

export function useTerminalLines(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: keys.terminal(),
    queryFn: async () =>
      (await getJson("/terminal", z.object({ lines: z.array(z.string()) }))).lines,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useHarnesses(): UseQueryResult<HarnessInfo[]> {
  return useQuery({
    queryKey: keys.harnesses(),
    queryFn: () => getJson("/harnesses", z.array(HarnessInfoSchema)),
    staleTime: STALE,
  });
}

export function useArtifactContent() {
  return useMutation({
    mutationFn: (artifactId: string) =>
      getJson(`/artifacts/${artifactId}/content`, ArtifactContentSchema),
  });
}

// ---------------------------------------------------------------- mutations

export function useCreateWorkspace(): UseMutationResult<Workspace, Error, CreateWorkspaceRequest> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateWorkspaceRequest) =>
      request("/workspaces", WorkspaceSchema, { method: "POST", json: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.workspaces() });
    },
  });
}

export function useCreateThread(
  workspaceId: string,
): UseMutationResult<Thread, Error, Omit<CreateThreadRequest, "workspaceId">> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateThreadRequest, "workspaceId">) =>
      request("/threads", ThreadSchema, { method: "POST", json: { ...input, workspaceId } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.threads(workspaceId) });
    },
  });
}

export function useUpdateThread(
  workspaceId: string,
): UseMutationResult<Thread, Error, { threadId: string; patch: UpdateThreadRequest }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, patch }: { threadId: string; patch: UpdateThreadRequest }) =>
      request(`/threads/${threadId}`, ThreadSchema, { method: "PATCH", json: patch }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.threads(workspaceId) });
    },
  });
}

export function useSendMessage(
  threadId: string,
): UseMutationResult<Message, Error, CreateMessageRequest> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMessageRequest) =>
      request(`/threads/${threadId}/messages`, MessageSchema, { method: "POST", json: input }),
    onSuccess: (message) => {
      client.setQueryData<Message[]>(keys.messages(threadId), (current) =>
        upsertById(current, message),
      );
    },
  });
}

export function useUpdateTask(
  threadId: string,
): UseMutationResult<Task, Error, { taskId: string; patch: UpdateTaskRequest }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, patch }: { taskId: string; patch: UpdateTaskRequest }) =>
      request(`/tasks/${taskId}`, TaskSchema, { method: "PATCH", json: patch }),
    onSuccess: (task) => {
      client.setQueryData<Task[]>(keys.tasks(threadId), (current) => upsertById(current, task));
    },
  });
}

export function useUpdateTaskStatus(
  threadId: string,
): UseMutationResult<Task, Error, { taskId: string; status: TaskStatus; order?: number }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      status,
      order,
    }: {
      taskId: string;
      status: TaskStatus;
      order?: number;
    }) =>
      request(`/tasks/${taskId}/status`, TaskSchema, { method: "POST", json: { status, order } }),
    // Move the card immediately; the server response replaces it on success and
    // the rollback puts it back if the write fails.
    onMutate: async ({ taskId, status }) => {
      await client.cancelQueries({ queryKey: keys.tasks(threadId) });
      const previous = client.getQueryData<Task[]>(keys.tasks(threadId));
      client.setQueryData<Task[]>(keys.tasks(threadId), (current) =>
        (current ?? []).map((task) => (task.id === taskId ? { ...task, status } : task)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(keys.tasks(threadId), context.previous);
    },
    onSuccess: (task) => {
      client.setQueryData<Task[]>(keys.tasks(threadId), (current) => upsertById(current, task));
    },
  });
}

export function useResolveApproval(
  workspaceId: string,
): UseMutationResult<
  Approval,
  Error,
  { approvalId: string; status: "approved" | "rejected"; resolvedBy?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      approvalId,
      status,
      resolvedBy,
    }: {
      approvalId: string;
      status: "approved" | "rejected";
      resolvedBy?: string;
    }) =>
      request(`/approvals/${approvalId}/resolve`, ApprovalSchema, {
        method: "POST",
        json: { status, resolvedBy },
      }),
    onSuccess: (approval) => {
      client.setQueryData<Approval[]>(keys.approvals(workspaceId), (current) =>
        upsertById(current, approval),
      );
    },
  });
}

export function useCreateMemory(
  workspaceId: string,
): UseMutationResult<Memory, Error, Omit<CreateMemoryRequest, "workspaceId">> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CreateMemoryRequest, "workspaceId">) =>
      request("/memories", MemorySchema, { method: "POST", json: { ...input, workspaceId } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.memories(workspaceId) });
    },
  });
}

export function useUpdateMemory(
  workspaceId: string,
): UseMutationResult<Memory, Error, { memoryId: string; patch: UpdateMemoryRequest }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ memoryId, patch }: { memoryId: string; patch: UpdateMemoryRequest }) =>
      request(`/memories/${memoryId}`, MemorySchema, { method: "PATCH", json: patch }),
    onSuccess: (memory) => {
      client.setQueryData<Memory[]>(keys.memories(workspaceId), (current) =>
        upsertById(current, memory),
      );
    },
  });
}

export function useSaveSettings(): UseMutationResult<AppSettings, Error, Partial<AppSettings>> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) =>
      request("/settings", AppSettingsSchema, { method: "PUT", json: patch }),
    onSuccess: (settings) => {
      client.setQueryData(keys.settings(), settings);
    },
  });
}

// ----------------------------------------------------------------- helpers

/** Replace a row by id, or append it, keeping the list's existing order. */
function upsertById<T extends { id: string }>(current: T[] | undefined, row: T): T[] {
  const list = current ?? [];
  const index = list.findIndex((item) => item.id === row.id);
  if (index === -1) return [...list, row];
  return list.map((item, position) => (position === index ? row : item));
}

/** Re-exported so the WebSocket layer and the hooks agree on the event type. */
export type { NexestraEvent };
