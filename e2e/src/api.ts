/**
 * Thin typed wrappers over the REST API.
 *
 * A spec that is *about* the UI still needs a workspace, a thread and some
 * tasks to look at. Building those through HTTP keeps each spec independent
 * of the others and keeps the assertions about the surface under test rather
 * than about the fixtures.
 */
import type { CreateTaskRequest, Task, Thread, Workspace } from "@nexestra/core";

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} → ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

export function createWorkspace(baseURL: string, path: string, name?: string): Promise<Workspace> {
  return json<Workspace>(`${baseURL}/api/workspaces`, {
    method: "POST",
    body: JSON.stringify(name ? { path, name } : { path }),
  });
}

export function createThread(baseURL: string, workspaceId: string, title: string): Promise<Thread> {
  return json<Thread>(`${baseURL}/api/threads`, {
    method: "POST",
    body: JSON.stringify({ workspaceId, title }),
  });
}

export function createTask(baseURL: string, input: CreateTaskRequest): Promise<Task> {
  return json<Task>(`${baseURL}/api/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export function listTasks(baseURL: string, threadId: string): Promise<Task[]> {
  return json<Task[]>(`${baseURL}/api/tasks?threadId=${encodeURIComponent(threadId)}`);
}

/** A workspace + thread pair for one spec, named after it. */
export interface Fixture {
  readonly workspace: Workspace;
  readonly thread: Thread;
  /** `/w/:workspaceId/t/:threadId` — append the surface. */
  readonly route: string;
}

export async function createFixture(
  baseURL: string,
  repoPath: string,
  label: string,
): Promise<Fixture> {
  const workspace = await createWorkspace(baseURL, repoPath, `e2e ${label}`);
  const thread = await createThread(baseURL, workspace.id, `${label} thread`);
  return { workspace, thread, route: `/w/${workspace.id}/t/${thread.id}` };
}
