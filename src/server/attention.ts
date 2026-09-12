import {
  type AgentRun,
  type AttentionItem,
  compareAttentionItems,
  runAttentionItem,
  type WorkAssignment,
  type WorkspaceActivityData,
} from "../shared/contracts.js";
import type { FileStore } from "./store.js";

type AttentionStore = Pick<
  FileStore,
  "listAgents" | "listThreads" | "listTasks" | "listAssignments" | "listAttentionStates"
>;

export function workspaceActivity(
  store: AttentionStore,
  workspaceId: string,
  runs: AgentRun[],
): WorkspaceActivityData {
  const agents = new Map(store.listAgents(workspaceId).map((agent) => [agent.id, agent]));
  const threads = new Map(store.listThreads(workspaceId).map((thread) => [thread.id, thread]));
  const activeRuns = runs.filter((run) => threads.has(run.threadId));
  const attention: AttentionItem[] = [];
  for (const run of activeRuns) {
    const thread = threads.get(run.threadId);
    if (!thread) continue;
    const item = runAttentionItem(run, agents.get(run.agentId)?.name ?? "Agent", thread.name);
    if (item) attention.push(item);
  }

  const latestAssignments = new Map<string, WorkAssignment>();
  for (const assignment of store.listAssignments(workspaceId)) {
    const previous = latestAssignments.get(assignment.taskId);
    if (
      !previous ||
      assignment.createdAt > previous.createdAt ||
      (assignment.createdAt === previous.createdAt && assignment.id > previous.id)
    ) {
      latestAssignments.set(assignment.taskId, assignment);
    }
  }

  for (const task of store.listTasks(workspaceId)) {
    if (task.status === "done") continue;
    const assignment = latestAssignments.get(task.id);
    if (assignment?.status === "queued" || assignment?.status === "running") continue;

    let kind: AttentionItem["kind"];
    let detail: string;
    if (assignment?.status === "failed") {
      kind = "task_failed";
      detail = "The latest Worker attempt failed. Review the task before trying again.";
    } else if (assignment?.status === "interrupted") {
      kind = "task_interrupted";
      detail = "The latest Worker attempt was interrupted. Review the task to continue.";
    } else if (task.status === "blocked") {
      kind = "task_blocked";
      detail = "This task is blocked and needs your attention.";
    } else {
      continue;
    }

    const threadId = assignment?.threadId ?? task.threadId;
    attention.push({
      id: `task:${task.id}`,
      kind,
      title: task.title,
      detail,
      taskId: task.id,
      ...(threadId && threads.has(threadId) ? { threadId } : {}),
      ...(assignment ? { runId: assignment.id } : {}),
      updatedAt:
        assignment && assignment.updatedAt > task.updatedAt ? assignment.updatedAt : task.updatedAt,
    });
  }

  attention.sort(compareAttentionItems);
  const now = Date.now();
  const states = new Map(
    store.listAttentionStates(workspaceId).map((state) => [state.attentionId, state]),
  );
  const visible = attention.filter((item) => {
    const state = states.get(item.id);
    if (!state) return true;
    if (state.dismissedAt && item.updatedAt < state.dismissedAt) return false;
    if (state.snoozedUntil && Date.parse(state.snoozedUntil) > now) return false;
    return true;
  });
  return { workspaceId, activeRuns, attention: visible };
}
