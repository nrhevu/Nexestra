import {
  type Approval,
  ApprovalSchema,
  type Artifact,
  ArtifactSchema,
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
  type Plan,
  PlanSchema,
  type Run,
  RunSchema,
  type Spec,
  SpecSchema,
  type Task,
  TaskSchema,
  type Thread,
  ThreadSchema,
  type Workspace,
  WorkspaceSchema,
} from "@nexestra/core";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { z } from "zod";

/** In dev, Vite proxies `/api` to the Hono server on 4242. */
const API_BASE = "/api/mock";

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}`);
  return schema.parse(await response.json());
}

const STALE = 30_000;

export function useWorkspaces(): UseQueryResult<Workspace[]> {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: () => getJson("/workspaces", z.array(WorkspaceSchema)),
    staleTime: STALE,
  });
}

export function useThreads(workspaceId: string): UseQueryResult<Thread[]> {
  return useQuery({
    queryKey: ["threads", workspaceId],
    queryFn: () => getJson(`/threads?workspaceId=${workspaceId}`, z.array(ThreadSchema)),
    staleTime: STALE,
  });
}

export function useMessages(threadId: string): UseQueryResult<Message[]> {
  return useQuery({
    queryKey: ["messages", threadId],
    queryFn: () => getJson(`/threads/${threadId}/messages`, z.array(MessageSchema)),
    staleTime: STALE,
  });
}

export function useSpec(threadId: string): UseQueryResult<Spec | null> {
  return useQuery({
    queryKey: ["spec", threadId],
    queryFn: () => getJson(`/threads/${threadId}/spec`, SpecSchema.nullable()),
    staleTime: STALE,
  });
}

export function usePlan(threadId: string): UseQueryResult<Plan | null> {
  return useQuery({
    queryKey: ["plan", threadId],
    queryFn: () => getJson(`/threads/${threadId}/plan`, PlanSchema.nullable()),
    staleTime: STALE,
  });
}

export function useTasks(threadId: string): UseQueryResult<Task[]> {
  return useQuery({
    queryKey: ["tasks", threadId],
    queryFn: () => getJson(`/tasks?threadId=${threadId}`, z.array(TaskSchema)),
    staleTime: STALE,
  });
}

export function useRuns(threadId: string): UseQueryResult<Run[]> {
  return useQuery({
    queryKey: ["runs", threadId],
    queryFn: () => getJson(`/runs?threadId=${threadId}`, z.array(RunSchema)),
    staleTime: STALE,
  });
}

export function useArtifacts(threadId: string): UseQueryResult<Artifact[]> {
  return useQuery({
    queryKey: ["artifacts", threadId],
    queryFn: () => getJson(`/artifacts?threadId=${threadId}`, z.array(ArtifactSchema)),
    staleTime: STALE,
  });
}

export function useMemories(workspaceId: string): UseQueryResult<Memory[]> {
  return useQuery({
    queryKey: ["memories", workspaceId],
    queryFn: () => getJson(`/memories?workspaceId=${workspaceId}`, z.array(MemorySchema)),
    staleTime: STALE,
  });
}

export function useApprovals(workspaceId: string): UseQueryResult<Approval[]> {
  return useQuery({
    queryKey: ["approvals", workspaceId],
    queryFn: () => getJson(`/approvals?workspaceId=${workspaceId}`, z.array(ApprovalSchema)),
    staleTime: STALE,
  });
}

export function useFileTree(): UseQueryResult<FileNode[]> {
  return useQuery({
    queryKey: ["files"],
    queryFn: () => getJson("/files", z.array(FileNodeSchema)),
    staleTime: STALE,
  });
}

export function useFileContent(path: string): UseQueryResult<FileContent> {
  return useQuery({
    queryKey: ["file", path],
    queryFn: () => getJson(`/files/content?path=${encodeURIComponent(path)}`, FileContentSchema),
    staleTime: STALE,
  });
}

export function useTerminalLines(): UseQueryResult<string[]> {
  return useQuery({
    queryKey: ["terminal"],
    queryFn: async () =>
      (await getJson("/terminal", z.object({ lines: z.array(z.string()) }))).lines,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useHarnesses(): UseQueryResult<HarnessInfo[]> {
  return useQuery({
    queryKey: ["harnesses"],
    queryFn: () => getJson("/harnesses", z.array(HarnessInfoSchema)),
    staleTime: STALE,
  });
}
