import { describe, expect, it, vi } from "vitest";
import type { Thread } from "../shared/contracts.js";
import { nextUnreadConversation, selectConversationList } from "./unreadNavigation.js";

function thread(id: string, workspaceId: string, messageCount = 0, archived = false): Thread {
  return {
    id,
    workspaceId,
    name: id,
    slug: id,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    messageCount,
    lastMessageAt: null,
    archived,
  };
}

describe("selectConversationList", () => {
  it("returns every workspace conversation in original active-then-archived order for all", () => {
    const first = thread("active-2", "ws-a", 0);
    const second = thread("active-1", "ws-a", 2);
    const third = thread("archived-1", "ws-a", 1, true);
    const fourth = thread("archived-2", "ws-a", 0, true);
    const result = selectConversationList({
      workspaceId: "ws-a",
      threads: [first, second, third, fourth],
      filter: "all",
      currentThreadId: "active-1",
      unreadFor: (t) => t.messageCount,
    });
    expect(result.active).toEqual([first, second]);
    expect(result.archived).toEqual([third, fourth]);
    expect(result.unreadConversationCount).toBe(2);
    expect(result.retainedCurrent).toBe(false);
  });

  it("keeps unread conversations and the selected conversation even when it is read", () => {
    const readActive = thread("active-read", "ws-a", 0);
    const unread1 = thread("active-unread", "ws-a", 2);
    const readArchived = thread("archived-read", "ws-a", 0, true);
    const unread2 = thread("archived-unread", "ws-a", 4, true);

    const activeResult = selectConversationList({
      workspaceId: "ws-a",
      threads: [readActive, unread1, readArchived, unread2],
      filter: "unread",
      currentThreadId: readActive.id,
      unreadFor: (t) => t.messageCount,
    });
    expect(activeResult.active).toEqual([readActive, unread1]);
    expect(activeResult.archived).toEqual([unread2]);
    expect(activeResult.retainedCurrent).toBe(true);

    const archivedResult = selectConversationList({
      workspaceId: "ws-a",
      threads: [readArchived, unread1],
      filter: "unread",
      currentThreadId: readArchived.id,
      unreadFor: (t) => t.messageCount,
    });
    expect(archivedResult.active).toEqual([unread1]);
    expect(archivedResult.archived).toEqual([readArchived]);
    expect(archivedResult.retainedCurrent).toBe(true);
  });

  it("drops read conversations under the unread filter unless one is current", () => {
    const unread1 = thread("unread", "ws-a", 2);
    const read = thread("read", "ws-a", 0);
    const result = selectConversationList({
      workspaceId: "ws-a",
      threads: [read, unread1],
      filter: "unread",
      unreadFor: (t) => t.messageCount,
    });
    expect(result.active).toEqual([unread1]);
    expect(result.archived).toEqual([]);
    expect(result.unreadConversationCount).toBe(1);
    expect(result.retainedCurrent).toBe(false);
  });

  it("only counts positive finite counts as unread", () => {
    const zero = thread("zero", "ws-a", 0);
    const negative = thread("negative", "ws-a", -1);
    const infinite = thread("infinite", "ws-a", Infinity);
    const positive = thread("positive", "ws-a", 1);
    const unreadFor = vi.fn((t: Thread) => t.messageCount);
    const result = selectConversationList({
      workspaceId: "ws-a",
      threads: [zero, negative, infinite, positive],
      filter: "all",
      unreadFor,
    });
    expect(result.active).toEqual([zero, negative, infinite, positive]);
    expect(result.unreadConversationCount).toBe(1);
  });

  it("filters foreign workspaces and deduplicates ids keeping the first valid entry", () => {
    const foreign = thread("shared", "ws-b", 5);
    const firstLocal = thread("shared", "ws-a", 3);
    const duplicateLocal = thread("shared", "ws-a", 9);
    const localOnly = thread("local", "ws-a", 2);
    const unreadFor = vi.fn((t: Thread) => t.messageCount);
    const result = selectConversationList({
      workspaceId: "ws-a",
      threads: [foreign, firstLocal, duplicateLocal, localOnly],
      filter: "unread",
      currentThreadId: "missing",
      unreadFor,
    });
    expect(result.active).toEqual([firstLocal, localOnly]);
    expect(result.archived).toEqual([]);
    expect(result.unreadConversationCount).toBe(2);
    expect(result.retainedCurrent).toBe(false);
    expect(unreadFor).toHaveBeenCalledTimes(2);
    expect(unreadFor).toHaveBeenNthCalledWith(1, firstLocal);
    expect(unreadFor).toHaveBeenNthCalledWith(2, localOnly);

    const firstForeignThenLocal = selectConversationList({
      workspaceId: "ws-a",
      threads: [foreign, localOnly],
      filter: "unread",
      unreadFor,
    });
    expect(firstForeignThenLocal.active).toEqual([localOnly]);
  });
});

describe("nextUnreadConversation", () => {
  it("returns the first unread when the current conversation is absent or unknown", () => {
    const first = thread("first", "ws-a", 2);
    const second = thread("second", "ws-a", 3);
    expect(
      nextUnreadConversation({
        workspaceId: "ws-a",
        threads: [first, second],
        unreadFor: (t) => t.messageCount,
      }),
    ).toBe(first);
    expect(
      nextUnreadConversation({
        workspaceId: "ws-a",
        threads: [first, second],
        currentThreadId: "unknown",
        unreadFor: (t) => t.messageCount,
      }),
    ).toBe(first);
  });

  it("picks the unread after current in active-then-archived order and wraps", () => {
    const active1 = thread("active-1", "ws-a", 2);
    const readActive = thread("read-active", "ws-a", 0);
    const archived1 = thread("archived-1", "ws-a", 4, true);
    const activeLast = thread("active-2", "ws-a", 3);
    const threads = [active1, readActive, activeLast, archived1];

    expect(
      nextUnreadConversation({
        workspaceId: "ws-a",
        threads,
        currentThreadId: activeLast.id,
        unreadFor: (t) => t.messageCount,
      }),
    ).toBe(archived1);
    expect(
      nextUnreadConversation({
        workspaceId: "ws-a",
        threads,
        currentThreadId: archived1.id,
        unreadFor: (t) => t.messageCount,
      }),
    ).toBe(active1);
  });

  it("skips the current conversation when another unread exists and otherwise returns it", () => {
    const active1 = thread("first", "ws-a", 2);
    const current = thread("current", "ws-a", 3);
    const active3 = thread("third", "ws-a", 4);
    const threads = [active1, current, active3];
    expect(
      nextUnreadConversation({
        workspaceId: "ws-a",
        threads,
        currentThreadId: current.id,
        unreadFor: (t) => t.messageCount,
      }),
    ).toBe(active3);

    const onlyCurrent = thread("only-current", "ws-a", 5);
    expect(
      nextUnreadConversation({
        workspaceId: "ws-a",
        threads: [onlyCurrent],
        currentThreadId: onlyCurrent.id,
        unreadFor: (t) => t.messageCount,
      }),
    ).toBe(onlyCurrent);
  });

  it("returns undefined when no conversation is unread", () => {
    const read1 = thread("read-1", "ws-a", 0);
    const read2 = thread("read-2", "ws-a", 0, true);
    expect(
      nextUnreadConversation({
        workspaceId: "ws-a",
        threads: [read1, read2],
        currentThreadId: read1.id,
        unreadFor: (t) => t.messageCount,
      }),
    ).toBeUndefined();
  });
});

it("never mutates the input array or conversation objects", () => {
  const original = [
    thread("first", "ws-b", 2),
    thread("second", "ws-a", 0),
    thread("third", "ws-a", 1, true),
  ];
  const snapshot = original.map((t) => ({ ...t }));
  selectConversationList({
    workspaceId: "ws-a",
    threads: original,
    filter: "unread",
    currentThreadId: "second",
    unreadFor: (t) => t.messageCount,
  });
  nextUnreadConversation({
    workspaceId: "ws-a",
    threads: original,
    currentThreadId: "second",
    unreadFor: (t) => t.messageCount,
  });
  expect(original.map((t) => ({ ...t }))).toEqual(snapshot);
});
