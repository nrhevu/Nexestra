import {
  ApiErrorSchema,
  type Approval,
  ApprovalSchema,
  type AppSettings,
  type AppSettingsResponse,
  AppSettingsResponseSchema,
  type Artifact,
  ArtifactContentSchema,
  ArtifactSchema,
  type CreateMasterProviderRequest,
  type CreateMemoryRequest,
  type CreateMessageRequest,
  type CreateThreadRequest,
  type CreateWorkspaceRequest,
  type DiscoverProviderModelsRequest,
  type DispatchTaskRequest,
  type DispatchTaskResponse,
  DispatchTaskResponseSchema,
  type ExecutionAction,
  type ExecutionStatus,
  ExecutionStatusSchema,
  type FileContent,
  FileContentSchema,
  type FileNode,
  FileNodeSchema,
  type HarnessInfo,
  HarnessInfoSchema,
  type MasterCancelResponse,
  MasterCancelResponseSchema,
  type MasterSendRequest,
  type MasterSendResponse,
  MasterSendResponseSchema,
  type MasterStateResponse,
  MasterStateResponseSchema,
  type Memory,
  MemorySchema,
  type Message,
  MessageSchema,
  type NexestraEvent,
  NexestraEventSchema,
  type OrchestratorProgress,
  OrchestratorProgressSchema,
  type Plan,
  PlanSchema,
  type ProviderModelList,
  ProviderModelListSchema,
  type Run,
  type RunControlRequest,
  type RunControlResponse,
  RunControlResponseSchema,
  type RunDiff,
  RunDiffSchema,
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
  type VerifyTaskResponse,
  VerifyTaskResponseSchema,
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
  masterState: (threadId: string) => ["masterState", threadId] as const,
  execution: (threadId: string) => ["execution", threadId] as const,
  progress: (threadId: string) => ["progress", threadId] as const,
  runFiles: (runId: string) => ["runFiles", runId] as const,
  runFile: (runId: string, path: string) => ["runFile", runId, path] as const,
  runDiff: (runId: string) => ["runDiff", runId] as const,
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

export function useSettings(): UseQueryResult<AppSettingsResponse> {
  return useQuery({
    queryKey: keys.settings(),
    queryFn: () => getJson("/settings", AppSettingsResponseSchema),
    staleTime: STALE,
  });
}

/**
 * What the Master is doing on this thread.
 *
 * The live view of a turn comes over `/ws`; this is the fallback that makes a
 * reload correct — which phase, whether a turn is in flight, and which
 * question or approval is still waiting on the user.
 */
export function useMasterState(threadId: string): UseQueryResult<MasterStateResponse> {
  return useQuery({
    queryKey: keys.masterState(threadId),
    queryFn: () => getJson(`/threads/${threadId}/master/state`, MasterStateResponseSchema),
    enabled: threadId.length > 0,
    staleTime: STALE,
  });
}

/* --------------------------------------------------------------- execution */

/**
 * Where the orchestrator stands on this thread.
 *
 * The live view arrives over `/ws` as `orchestrator.status_changed`, which is
 * written straight into this cache entry; the query is what makes a reload
 * correct and what seeds the first render.
 */
export function useExecutionStatus(threadId: string): UseQueryResult<ExecutionStatus> {
  return useQuery({
    queryKey: keys.execution(threadId),
    queryFn: () => getJson(`/threads/${threadId}/execution/status`, ExecutionStatusSchema),
    enabled: threadId.length > 0,
    staleTime: STALE,
  });
}

/**
 * The orchestrator's progress lines, read back out of the thread's event log.
 *
 * Same trick as the status: the log is the durable copy (so a reload shows the
 * whole run), and `/ws` appends new lines to this cache entry as they happen.
 */
export function useThreadProgress(threadId: string): UseQueryResult<OrchestratorProgress[]> {
  return useQuery({
    queryKey: keys.progress(threadId),
    queryFn: async () => {
      const events = await getJson(`/threads/${threadId}/events`, z.array(NexestraEventSchema));
      return events
        .filter((event) => event.type === "orchestrator.progress")
        .flatMap((event) => {
          const parsed = OrchestratorProgressSchema.safeParse(event.payload);
          return parsed.success ? [parsed.data] : [];
        });
    },
    enabled: threadId.length > 0,
    staleTime: STALE,
  });
}

/** The file tree of a run's worktree. */
export function useRunFiles(runId: string | undefined): UseQueryResult<FileNode[]> {
  return useQuery({
    queryKey: keys.runFiles(runId ?? ""),
    queryFn: () => getJson(`/runs/${runId}/files`, z.array(FileNodeSchema)),
    enabled: Boolean(runId),
    staleTime: STALE,
  });
}

export function useRunFileContent(
  runId: string | undefined,
  path: string | undefined,
): UseQueryResult<FileContent> {
  return useQuery({
    queryKey: keys.runFile(runId ?? "", path ?? ""),
    queryFn: () => getJson(`/runs/${runId}/files/content${query({ path })}`, FileContentSchema),
    enabled: Boolean(runId && path),
    staleTime: STALE,
  });
}

/** The unified diff of a run's worktree against the branch it was cut from. */
export function useRunDiff(runId: string | undefined): UseQueryResult<RunDiff> {
  return useQuery({
    queryKey: keys.runDiff(runId ?? ""),
    queryFn: () => getJson(`/runs/${runId}/diff`, RunDiffSchema),
    enabled: Boolean(runId),
    staleTime: STALE,
  });
}

/**
 * What the server can actually drive.
 *
 * `discover()` shells out, so the server caches it; this is the cached copy.
 * `useRefreshHarnesses()` asks the server to detect again, which is what a
 * user who just installed Codex needs.
 */
export function useHarnesses(): UseQueryResult<HarnessInfo[]> {
  return useQuery({
    queryKey: keys.harnesses(),
    queryFn: () => getJson("/harnesses", z.array(HarnessInfoSchema)),
    staleTime: STALE,
  });
}

export function useRefreshHarnesses(): UseMutationResult<HarnessInfo[], Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => getJson("/harnesses?refresh=1", z.array(HarnessInfoSchema)),
    onSuccess: (harnesses) => {
      client.setQueryData(keys.harnesses(), harnesses);
    },
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

export function useSaveSettings(): UseMutationResult<
  AppSettingsResponse,
  Error,
  Partial<AppSettings>
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) =>
      request("/settings", AppSettingsResponseSchema, { method: "PUT", json: patch }),
    onSuccess: (settings) => {
      client.setQueryData(keys.settings(), settings);
    },
  });
}

export function useSaveProviderCredential(): UseMutationResult<
  AppSettingsResponse,
  Error,
  { providerId: string; credential: string | null }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ providerId, credential }) =>
      request(
        `/settings/providers/${encodeURIComponent(providerId)}/credential`,
        AppSettingsResponseSchema,
        {
          method: credential === null ? "DELETE" : "PUT",
          ...(credential === null ? {} : { json: { credential } }),
        },
      ),
    onSuccess: (settings) => {
      client.setQueryData(keys.settings(), settings);
    },
  });
}

export function useCreateMasterProvider(): UseMutationResult<
  AppSettingsResponse,
  Error,
  CreateMasterProviderRequest
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      request("/settings/providers", AppSettingsResponseSchema, {
        method: "POST",
        json: input,
      }),
    onSuccess: (settings) => {
      client.setQueryData(keys.settings(), settings);
    },
  });
}

export function useDiscoverProviderModels(): UseMutationResult<
  ProviderModelList,
  Error,
  DiscoverProviderModelsRequest
> {
  return useMutation({
    mutationFn: (input) =>
      request("/settings/providers/discover-models", ProviderModelListSchema, {
        method: "POST",
        json: input,
      }),
  });
}

export function useProviderModels(
  providerId: string,
  enabled = true,
): UseQueryResult<ProviderModelList> {
  return useQuery({
    queryKey: ["provider-models", providerId],
    queryFn: () =>
      getJson(
        `/settings/providers/${encodeURIComponent(providerId)}/models`,
        ProviderModelListSchema,
      ),
    enabled: enabled && providerId.length > 0,
    staleTime: STALE,
  });
}

/**
 * Send something to the Master: a message, answers to `ask_user`, an approval
 * decision, or a nudge to continue.
 *
 * The response is a `202` with a `turnId` — the turn itself arrives as
 * `master.*` events, so nothing here waits on the model.
 */
export function useMasterSend(
  threadId: string,
): UseMutationResult<MasterSendResponse, Error, MasterSendRequest> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MasterSendRequest) =>
      request(`/threads/${threadId}/master/send`, MasterSendResponseSchema, {
        method: "POST",
        json: input,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.messages(threadId) });
      void client.invalidateQueries({ queryKey: keys.masterState(threadId) });
    },
  });
}

/* ------------------------------------------------------- execution control */

/**
 * `[Start execution]` / `[Pause]` / `[Resume]` / `[Cancel]` on the board.
 *
 * The response is the fresh `ExecutionStatus`, written straight into the cache
 * so the header flips before the first `orchestrator.status_changed` arrives.
 */
export function useExecutionControl(
  threadId: string,
): UseMutationResult<ExecutionStatus, Error, ExecutionAction> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: ExecutionAction) =>
      request(`/threads/${threadId}/execution/${action}`, ExecutionStatusSchema, {
        method: "POST",
        json: {},
      }),
    onSuccess: (status) => {
      client.setQueryData(keys.execution(threadId), status);
      void client.invalidateQueries({ queryKey: keys.tasks(threadId) });
    },
  });
}

/** Run one task now, out of band of the scheduler. */
export function useDispatchTask(
  threadId: string,
): UseMutationResult<DispatchTaskResponse, Error, { taskId: string; body?: DispatchTaskRequest }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, body: input }: { taskId: string; body?: DispatchTaskRequest }) =>
      request(`/tasks/${taskId}/dispatch`, DispatchTaskResponseSchema, {
        method: "POST",
        json: input ?? {},
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.runs(threadId) });
      void client.invalidateQueries({ queryKey: keys.tasks(threadId) });
    },
  });
}

/** Run a task's acceptance criteria now and record the evidence. */
export function useVerifyTask(
  threadId: string,
): UseMutationResult<VerifyTaskResponse, Error, { taskId: string; criterionIds?: string[] }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, criterionIds }: { taskId: string; criterionIds?: string[] }) =>
      request(`/tasks/${taskId}/verify`, VerifyTaskResponseSchema, {
        method: "POST",
        json: criterionIds ? { criterionIds } : {},
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.tasks(threadId) });
      void client.invalidateQueries({ queryKey: keys.spec(threadId) });
      void client.invalidateQueries({ queryKey: keys.artifacts(threadId) });
    },
  });
}

/** Cancel / steer / answer a permission prompt on a live run. */
export function useRunControl(
  threadId: string,
): UseMutationResult<RunControlResponse, Error, { runId: string; body: RunControlRequest }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, body: input }: { runId: string; body: RunControlRequest }) =>
      request(`/runs/${runId}/control`, RunControlResponseSchema, {
        method: "POST",
        json: input,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.runs(threadId) });
    },
  });
}

export function useMasterCancel(
  threadId: string,
): UseMutationResult<MasterCancelResponse, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      request(`/threads/${threadId}/master/cancel`, MasterCancelResponseSchema, {
        method: "POST",
        json: {},
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.masterState(threadId) });
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
