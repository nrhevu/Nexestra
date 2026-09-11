import type { Thread } from "../shared/contracts.js";

export type ConversationFilter = "all" | "unread";

const isUnread = (count: number): boolean => Number.isFinite(count) && count > 0;

function uniqueWorkspaceThreads(workspaceId: string, threads: readonly Thread[]): Thread[] {
  const seenIds = new Set<string>();
  const unique: Thread[] = [];
  for (const thread of threads) {
    if (thread.workspaceId !== workspaceId) continue;
    if (seenIds.has(thread.id)) continue;
    seenIds.add(thread.id);
    unique.push(thread);
  }
  return unique;
}

function splitByArchived(threads: readonly Thread[]): { active: Thread[]; archived: Thread[] } {
  const active: Thread[] = [];
  const archived: Thread[] = [];
  for (const thread of threads) {
    if (thread.archived) archived.push(thread);
    else active.push(thread);
  }
  return { active, archived };
}

const isKept = (
  filter: ConversationFilter,
  unreadThreads: ReadonlySet<Thread>,
  current: Thread | undefined,
  thread: Thread,
): boolean => filter === "all" || unreadThreads.has(thread) || thread === current;

export function selectConversationList(input: {
  workspaceId: string;
  threads: readonly Thread[];
  filter: ConversationFilter;
  currentThreadId?: string;
  unreadFor: (thread: Thread) => number;
}): {
  active: Thread[];
  archived: Thread[];
  unreadConversationCount: number;
  retainedCurrent: boolean;
} {
  const unique = uniqueWorkspaceThreads(input.workspaceId, input.threads);
  const unreadThreads = new Set<Thread>();
  let current: Thread | undefined;
  let unreadConversationCount = 0;
  for (const thread of unique) {
    if (input.currentThreadId !== undefined && thread.id === input.currentThreadId) {
      current = thread;
    }
    if (isUnread(input.unreadFor(thread))) {
      unreadThreads.add(thread);
      unreadConversationCount += 1;
    }
  }

  const retainedCurrent =
    input.filter === "unread" && current !== undefined && !unreadThreads.has(current);

  const { active, archived } = splitByArchived(unique);
  return {
    active: active.filter((thread) => isKept(input.filter, unreadThreads, current, thread)),
    archived: archived.filter((thread) => isKept(input.filter, unreadThreads, current, thread)),
    unreadConversationCount,
    retainedCurrent,
  };
}

export function nextUnreadConversation(input: {
  workspaceId: string;
  threads: readonly Thread[];
  currentThreadId?: string;
  unreadFor: (thread: Thread) => number;
}): Thread | undefined {
  const unique = uniqueWorkspaceThreads(input.workspaceId, input.threads);
  const { active, archived } = splitByArchived(unique);
  const ordered = active.concat(archived);

  const unreadThreads = new Set<Thread>();
  let firstUnread: Thread | undefined;
  let currentIndex = -1;
  ordered.forEach((thread, index) => {
    if (input.currentThreadId !== undefined && thread.id === input.currentThreadId) {
      currentIndex = index;
    }
    if (isUnread(input.unreadFor(thread))) {
      unreadThreads.add(thread);
      if (firstUnread === undefined) firstUnread = thread;
    }
  });
  if (firstUnread === undefined) return undefined;

  const current = ordered[currentIndex];
  if (current === undefined) return firstUnread;

  for (let offset = 1; offset <= ordered.length; offset += 1) {
    const candidate = ordered[(currentIndex + offset) % ordered.length];
    if (candidate !== undefined && unreadThreads.has(candidate)) return candidate;
  }
  if (unreadThreads.has(current)) return current;
  return undefined;
}
