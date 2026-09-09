// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseReadStateKey,
  READ_STATE_MAX_STORAGE_BYTES,
  READ_STATE_MAX_THREADS,
  ReadState,
  readStateKey,
} from "./readState.js";

function thread(id: string, workspaceId: string, messageCount: number) {
  return { id, workspaceId, messageCount };
}

describe("ReadState", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("baselines a fresh workspace and treats later discovered threads as unread", () => {
    const state = new ReadState();
    const ws = "workspace-a";
    expect(state.unread(ws, "t1", 5)).toBe(0);
    expect(state.observe(ws, [thread("t1", ws, 5)])).toBe(true);
    expect(state.unread(ws, "t1", 5)).toBe(0);
    expect(state.unread(ws, "t1", 8)).toBe(3);
    expect(state.observe(ws, [thread("t1", ws, 5), thread("t2", ws, 3)])).toBe(true);
    expect(state.unread(ws, "t2", 3)).toBe(3);
    expect(state.observe(ws, [thread("t1", ws, 5), thread("t2", ws, 3)])).toBe(false);
  });

  it("restored saved markers keep read counts and unknown threads stay unread", () => {
    const ws = "workspace-a";
    window.localStorage.setItem(
      readStateKey(ws),
      JSON.stringify({ version: 1, workspaceId: ws, counts: { t1: 7, t2: 3 } }),
    );
    const state = new ReadState();
    expect(state.observe(ws, [thread("t1", ws, 10), thread("t3", ws, 4)])).toBe(true);
    expect(state.unread(ws, "t1", 10)).toBe(3);
    expect(state.unread(ws, "t2", 3)).toBe(0);
    expect(state.unread(ws, "t3", 4)).toBe(4);
    expect(state.unread(ws, "t1", 5)).toBe(0);
  });

  it("a saved empty workspace marker means later threads are unread", () => {
    const ws = "workspace-empty";
    const state = new ReadState();
    state.observe(ws, []);
    expect(JSON.parse(window.localStorage.getItem(readStateKey(ws)) as string)).toEqual({
      version: 1,
      workspaceId: ws,
      counts: {},
    });
    const second = new ReadState();
    second.observe(ws, [thread("t1", ws, 4)]);
    expect(second.unread(ws, "t1", 4)).toBe(4);
  });

  it("advances only through the count actually acknowledged and never rolls back", () => {
    const state = new ReadState();
    const ws = "workspace-a";
    state.observe(ws, [thread("t1", ws, 10)]);
    state.observe(ws, [thread("t1", ws, 10), thread("t2", ws, 3)]);
    expect(state.unread(ws, "t2", 3)).toBe(3);
    expect(state.markRead(ws, "t2", 4)).toBe(true);
    expect(state.unread(ws, "t2", 4)).toBe(0);
    expect(state.markRead(ws, "t2", 2)).toBe(false);
    expect(state.unread(ws, "t2", 4)).toBe(0);
    expect(state.markRead(ws, "t2", 4)).toBe(false);
    expect(state.markRead(ws, "t2", 6)).toBe(true);
    expect(state.unread(ws, "t2", 6)).toBe(0);
  });

  it("ignores stale smaller metadata instead of rolling markers back", () => {
    const state = new ReadState();
    const ws = "workspace-a";
    state.observe(ws, [thread("t1", ws, 10)]);
    state.observe(ws, [thread("t1", ws, 10), thread("t2", ws, 8)]);
    state.markRead(ws, "t2", 8);
    expect(state.observe(ws, [thread("t1", ws, 5), thread("t2", ws, 3)])).toBe(false);
    expect(state.unread(ws, "t2", 3)).toBe(0);
    expect(state.unread(ws, "t2", 10)).toBe(2);
    expect(state.unread(ws, "t1", 4)).toBe(0);
    expect(state.markRead(ws, "t2", 6)).toBe(false);
  });

  it("keeps each workspace isolated and uses the versioned key format", () => {
    const state = new ReadState();
    const first = "workspace-one";
    const second = "workspace-two";
    state.observe(first, [thread("t1", first, 10)]);
    state.observe(second, [thread("t2", second, 9)]);
    state.observe(second, [thread("t2", second, 9), thread("t3", second, 4)]);
    expect(state.unread(second, "t3", 4)).toBe(4);
    expect(state.unread(first, "t3", 4)).toBe(0);
    state.markRead(second, "t3", 4);
    expect(state.unread(first, "t3", 4)).toBe(0);
    expect(state.unread(first, "t1", 10)).toBe(0);
    expect(state.unread(second, "t2", 9)).toBe(0);
    expect(readStateKey(first)).toBe("nexestra.readState.1.workspace-one");
    expect(parseReadStateKey("nexestra.readState.1.workspace-one")).toBe("workspace-one");
    expect(parseReadStateKey("nexestra.draft.1.workspace-one")).toBeNull();
    expect(window.localStorage.getItem(readStateKey(second))).not.toBeNull();
  });

  it("ignores malformed, oversized, foreign, and prototype-polluted storage", () => {
    const ws = "workspace-bad";
    window.localStorage.setItem(readStateKey(ws), "{not json");
    const malformed = new ReadState();
    malformed.observe(ws, [thread("t1", ws, 5)]);
    expect(malformed.unread(ws, "t1", 5)).toBe(0);
    expect(malformed.markRead(ws, "t2", 3)).toBe(true);
    expect(malformed.unread(ws, "t2", 3)).toBe(0);

    window.localStorage.setItem(readStateKey(ws), "x".repeat(READ_STATE_MAX_STORAGE_BYTES + 1));
    const oversized = new ReadState();
    oversized.observe(ws, [thread("t1", ws, 5)]);
    expect(oversized.unread(ws, "t1", 5)).toBe(0);

    window.localStorage.setItem(
      readStateKey(ws),
      JSON.stringify(
        JSON.parse(`{"version":1,"workspaceId":"${ws}","counts":{"__proto__":5,"t1":2}}`),
      ),
    );
    const poisoned = new ReadState();
    poisoned.observe(ws, [thread("t1", ws, 5)]);
    expect(poisoned.unread(ws, "t1", 5)).toBe(0);
    expect(poisoned.unread(ws, "__proto__", 9)).toBe(0);

    window.localStorage.setItem(
      readStateKey(ws),
      JSON.stringify({ version: 1, workspaceId: "other-workspace", counts: { t1: 2 } }),
    );
    const foreign = new ReadState();
    foreign.observe(ws, [thread("t1", ws, 5)]);
    expect(foreign.unread(ws, "t1", 5)).toBe(0);
  });

  it("melds independent tab markers into shared storage instead of overwriting them", () => {
    const ws = "workspace-a";
    const tabA = new ReadState();
    tabA.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    tabA.markRead(ws, "t1", 5);
    expect(JSON.parse(window.localStorage.getItem(readStateKey(ws)) as string).counts).toEqual({
      t1: 5,
      t2: 0,
    });

    const tabB = new ReadState();
    tabB.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    tabB.markRead(ws, "t2", 3);
    expect(JSON.parse(window.localStorage.getItem(readStateKey(ws)) as string).counts).toEqual({
      t1: 5,
      t2: 3,
    });

    const reloaded = new ReadState();
    reloaded.observe(ws, [thread("t1", ws, 6), thread("t2", ws, 4)]);
    expect(reloaded.unread(ws, "t1", 6)).toBe(1);
    expect(reloaded.unread(ws, "t2", 4)).toBe(1);
  });

  it("merges storage events monotonically and repairs a stale disk snapshot once", () => {
    const ws = "workspace-a";
    const tabA = new ReadState();
    tabA.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    tabA.markRead(ws, "t1", 5);

    const tabB = new ReadState();
    tabB.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    tabB.markRead(ws, "t2", 3);

    const staleFromA = JSON.stringify({
      version: 1,
      workspaceId: ws,
      counts: { t1: 5, t2: 0 },
    });
    expect(tabB.syncStorage(readStateKey(ws), staleFromA)).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(readStateKey(ws)) as string).counts).toEqual({
      t1: 5,
      t2: 3,
    });
    expect(tabB.unread(ws, "t2", 3)).toBe(0);
    expect(tabB.unread(ws, "t1", 5)).toBe(0);

    const fromAWithNew = JSON.stringify({
      version: 1,
      workspaceId: ws,
      counts: { t1: 5, t2: 0, t3: 2 },
    });
    expect(tabB.syncStorage(readStateKey(ws), fromAWithNew)).toBe(true);
    expect(tabB.unread(ws, "t3", 2)).toBe(0);
    expect(tabB.unread(ws, "t1", 5)).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(readStateKey(ws)) as string).counts).toEqual({
      t1: 5,
      t2: 3,
      t3: 2,
    });

    const staleLower = JSON.stringify({
      version: 1,
      workspaceId: ws,
      counts: { t1: 2, t2: 0, t3: 1 },
    });
    expect(tabB.syncStorage(readStateKey(ws), staleLower)).toBe(false);
    expect(tabB.unread(ws, "t3", 2)).toBe(0);
    expect(tabB.unread(ws, "t1", 5)).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(readStateKey(ws)) as string).counts).toEqual({
      t1: 5,
      t2: 3,
      t3: 2,
    });

    expect(tabB.syncStorage(readStateKey(ws), null)).toBe(false);
    expect(tabB.syncStorage("nexestra.unrelated", JSON.stringify({ version: 1 }))).toBe(false);
    expect(
      tabB.syncStorage(
        readStateKey("other-workspace"),
        JSON.stringify({ version: 1, workspaceId: ws, counts: { t1: 9 } }),
      ),
    ).toBe(false);
  });

  it("returns counts merged from the current disk snapshot during repair", () => {
    const ws = "workspace-a";
    const tabA = new ReadState();
    tabA.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    tabA.markRead(ws, "t1", 5);

    const tabB = new ReadState();
    tabB.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    expect(tabB.unread(ws, "t2", 7)).toBe(7);

    // A stale event payload was queued before another tab wrote both markers.
    window.localStorage.setItem(
      readStateKey(ws),
      JSON.stringify({ version: 1, workspaceId: ws, counts: { t1: 5, t2: 7 } }),
    );
    const staleEvent = JSON.stringify({
      version: 1,
      workspaceId: ws,
      counts: { t1: 4, t2: 0 },
    });

    expect(tabB.syncStorage(readStateKey(ws), staleEvent)).toBe(true);
    expect(tabB.unread(ws, "t2", 7)).toBe(0);
    expect(window.localStorage.getItem(readStateKey(ws))).toBe(
      JSON.stringify({ version: 1, workspaceId: ws, counts: { t1: 5, t2: 7 } }),
    );
  });

  it("does not rewrite disk that already contains the merged union", () => {
    const ws = "workspace-a";
    const tabA = new ReadState();
    tabA.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    tabA.markRead(ws, "t1", 5);

    const tabB = new ReadState();
    tabB.observe(ws, [thread("t1", ws, 0), thread("t2", ws, 0)]);
    tabB.markRead(ws, "t2", 3);

    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    const staleEvent = JSON.stringify({
      version: 1,
      workspaceId: ws,
      counts: { t1: 4, t2: 0 },
    });
    expect(tabB.syncStorage(readStateKey(ws), staleEvent)).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
    expect(tabB.unread(ws, "t2", 3)).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(readStateKey(ws)) as string).counts).toEqual({
      t1: 5,
      t2: 3,
    });
    setSpy.mockRestore();
  });
  it("keeps in-memory acknowledgements when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    const state = new ReadState();
    const ws = "workspace-a";
    expect(state.observe(ws, [thread("t1", ws, 5)])).toBe(true);
    expect(state.unread(ws, "t1", 7)).toBe(2);
    expect(state.markRead(ws, "t1", 6)).toBe(true);
    expect(state.unread(ws, "t1", 7)).toBe(1);
    expect(state.persistenceAvailable()).toBe(false);
    setSpy.mockRestore();
    expect(state.markRead(ws, "t1", 8)).toBe(true);
    expect(state.persistenceAvailable()).toBe(true);
  });

  it("caps outgoing payloads at the thread limit without losing memory", () => {
    const ws = "workspace-a";
    const state = new ReadState();
    const many = Array.from({ length: READ_STATE_MAX_THREADS + 1 }, (_, i) =>
      thread(`thread-${i}`, ws, 1),
    );
    expect(state.observe(ws, many)).toBe(true);
    expect(state.unread(ws, "thread-0", 1)).toBe(0);
    expect(state.unread(ws, `thread-${READ_STATE_MAX_THREADS}`, 1)).toBe(0);
    expect(state.persistenceAvailable()).toBe(false);
  });

  it("marks all provided conversations read in one action without lowering markers", () => {
    const ws = "workspace-a";
    const state = new ReadState();
    state.observe(ws, [thread("t1", ws, 5)]);
    state.observe(ws, [thread("t1", ws, 5), thread("t2", ws, 3), thread("t3", ws, 7)]);
    expect(state.unread(ws, "t2", 3)).toBe(3);
    expect(state.unread(ws, "t3", 7)).toBe(7);
    expect(
      state.markAllRead(ws, [thread("t1", ws, 5), thread("t2", ws, 3), thread("t3", ws, 7)]),
    ).toBe(true);
    expect(state.unread(ws, "t1", 5)).toBe(0);
    expect(state.unread(ws, "t2", 3)).toBe(0);
    expect(state.unread(ws, "t3", 7)).toBe(0);
    expect(
      state.markAllRead(ws, [thread("t1", ws, 5), thread("t2", ws, 3), thread("t3", ws, 7)]),
    ).toBe(false);
    expect(
      state.markAllRead(ws, [thread("t1", ws, 2), thread("t2", ws, 1), thread("t3", ws, 4)]),
    ).toBe(false);
    expect(state.unread(ws, "t3", 7)).toBe(0);
    expect(state.unread(ws, "t2", 3)).toBe(0);
  });
});
