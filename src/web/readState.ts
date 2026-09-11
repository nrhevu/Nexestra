import type { Thread } from "../shared/contracts.js";

// Browser-persisted read state for conversation lists. Storage contains only thread IDs and
// whole-message counts, never message text, attachments, or workspace internals. Counts are
// monotone within one tab lifetime: hydration, cross-tab storage events, and metadata updates
// can only raise a marker, never roll it back. Every persist best-effort melds the current valid
// disk snapshot before writing so two tabs marking different threads converge; because
// localStorage read+write is not an atomic cross-tab transaction, storage events additionally
// repair a stale lower/missing disk snapshot when they arrive. Storage deletion/corruption never
// discards in-memory acknowledgements during the current session; a reload before the next
// successful persist loses marks that were only held in memory.

export const READ_STATE_VERSION = 1;
export const READ_STATE_PREFIX = "nexestra.readState.1.";
export const READ_STATE_MAX_THREADS = 5000;
export const READ_STATE_MAX_COUNT = 1_000_000_000;
export const READ_STATE_MAX_STORAGE_BYTES = 256 * 1024;
export const READ_STATE_MAX_ID_LENGTH = 200;

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Persisted key format: nexestra.readState.1.<workspaceId>
export function readStateKey(workspaceId: string): string {
  return READ_STATE_PREFIX + workspaceId;
}

export function parseReadStateKey(key: string): string | null {
  if (!key.startsWith(READ_STATE_PREFIX)) return null;
  const workspaceId = key.slice(READ_STATE_PREFIX.length);
  return workspaceId.length > 0 && workspaceId.length <= READ_STATE_MAX_ID_LENGTH
    ? workspaceId
    : null;
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= READ_STATE_MAX_ID_LENGTH &&
    !RESERVED_KEYS.has(value)
  );
}

function validCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= READ_STATE_MAX_COUNT
  );
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length;
}

function parseStoredPayload(value: string, workspaceId: string): Map<string, number> | null {
  if (byteLength(value) > READ_STATE_MAX_STORAGE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== READ_STATE_VERSION || record.workspaceId !== workspaceId) return null;
  if (!record.counts || typeof record.counts !== "object" || Array.isArray(record.counts)) {
    return null;
  }
  const rawCounts = record.counts as Record<string, unknown>;
  const entries = Object.keys(rawCounts);
  if (entries.length > READ_STATE_MAX_THREADS) return null;
  const counts = new Map<string, number>();
  for (const threadId of entries) {
    const count = rawCounts[threadId];
    if (!validId(threadId) || !validCount(count)) return null;
    counts.set(threadId, count);
  }
  return counts;
}

interface WorkspaceState {
  workspaceId: string;
  storageKey: string;
  counts: Map<string, number>;
  known: Set<string>;
  baselined: boolean;
}

export class ReadState {
  private readonly sessions = new Map<string, WorkspaceState>();
  private storageOk = true;

  // Reports the last known I/O result. A real successful write restores true; denied read/write
  // access marks persistence unavailable while in-memory state keeps working.
  persistenceAvailable(): boolean {
    return this.storageOk;
  }

  private readValue(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      this.storageOk = false;
      return null;
    }
  }

  private writeValue(key: string, value: string): boolean {
    try {
      window.localStorage.setItem(key, value);
      this.storageOk = true;
      return true;
    } catch {
      this.storageOk = false;
      return false;
    }
  }

  private session(workspaceId: string): WorkspaceState | undefined {
    if (!validId(workspaceId)) return undefined;
    let state = this.sessions.get(workspaceId);
    if (!state) {
      state = {
        workspaceId,
        storageKey: readStateKey(workspaceId),
        counts: new Map(),
        known: new Set(),
        baselined: false,
      };
      this.sessions.set(workspaceId, state);
    }
    return state;
  }

  // Merges one validated count map into memory, returning whether any marker was added or raised.
  private mergeCounts(state: WorkspaceState, counts: Map<string, number>): boolean {
    let changed = false;
    for (const [threadId, count] of counts) {
      state.known.add(threadId);
      const current = state.counts.get(threadId);
      if (current === undefined || count > current) {
        state.counts.set(threadId, count);
        changed = true;
      }
    }
    return changed;
  }

  // Best-effort merge of the current valid disk snapshot into memory. localStorage read+write is
  // not an atomic cross-tab transaction, so this cannot guarantee convergence by itself; storage
  // events repair remaining stale snapshots. Invalid or missing disk data is left alone.
  private meldFromStorage(state: WorkspaceState): boolean {
    const saved = this.readValue(state.storageKey);
    if (saved === null) return false;
    const parsed = parseStoredPayload(saved, state.workspaceId);
    if (!parsed) return false;
    return this.mergeCounts(state, parsed);
  }

  private writeUnion(state: WorkspaceState): void {
    if (state.counts.size > READ_STATE_MAX_THREADS) {
      this.storageOk = false;
      return;
    }
    const counts: Record<string, number> = {};
    for (const [threadId, count] of state.counts) counts[threadId] = count;
    const payload = JSON.stringify({
      version: READ_STATE_VERSION,
      workspaceId: state.workspaceId,
      counts,
    });
    if (byteLength(payload) > READ_STATE_MAX_STORAGE_BYTES) {
      this.storageOk = false;
      return;
    }
    this.writeValue(state.storageKey, payload);
  }

  private persist(state: WorkspaceState): void {
    this.meldFromStorage(state);
    this.writeUnion(state);
  }

  // First valid observation distinguishes a fresh workspace (no saved marker) from a restored
  // initialized workspace (valid saved marker). Fresh conversations are baselined to their
  // current message counts so a new install does not flood the sidebar with retroactive unread.
  // A restored workspace keeps saved markers and newly discovered threads begin readCount 0, so
  // external activity created while the browser was closed still appears unread. Invalid saved
  // data is treated as fresh: there is no trustworthy marker to restore.
  observe(
    workspaceId: string,
    threads: ReadonlyArray<Pick<Thread, "id" | "workspaceId" | "messageCount">>,
  ): boolean {
    const state = this.session(workspaceId);
    if (!state) return false;
    if (!state.baselined) {
      const saved = this.readValue(state.storageKey);
      const parsed = saved !== null ? parseStoredPayload(saved, workspaceId) : null;
      const restored = parsed !== null;
      if (parsed) this.mergeCounts(state, parsed);
      state.baselined = true;
      for (const thread of threads) {
        if (thread.workspaceId !== workspaceId || !validId(thread.id)) continue;
        if (state.known.has(thread.id)) continue;
        let messageCount = 0;
        if (!restored && validCount(thread.messageCount)) messageCount = thread.messageCount;
        state.counts.set(thread.id, messageCount);
        state.known.add(thread.id);
      }
      this.persist(state);
      return true;
    }
    let changed = false;
    for (const thread of threads) {
      if (thread.workspaceId !== workspaceId || !validId(thread.id)) continue;
      if (!state.known.has(thread.id)) {
        state.counts.set(thread.id, 0);
        state.known.add(thread.id);
        changed = true;
      }
    }
    if (changed) this.persist(state);
    return changed;
  }

  unread(workspaceId: string, threadId: string, totalMessages: number): number {
    const state = this.sessions.get(workspaceId);
    if (!state || !validId(threadId)) return 0;
    const readCount = state.counts.get(threadId);
    if (readCount === undefined) return 0;
    const total = validCount(totalMessages) ? totalMessages : 0;
    return Math.max(0, total - readCount);
  }

  // Advances only through the count the caller actually rendered/acknowledged. A stale lower
  // acknowledgement is ignored; the marker never moves backwards.
  markRead(workspaceId: string, threadId: string, readThroughCount: number): boolean {
    if (!validId(workspaceId) || !validId(threadId) || !validCount(readThroughCount)) return false;
    const state = this.session(workspaceId);
    if (!state) return false;
    const current = state.counts.get(threadId) ?? 0;
    if (readThroughCount <= current) return false;
    state.counts.set(threadId, readThroughCount);
    state.known.add(threadId);
    this.persist(state);
    return true;
  }

  markAllRead(
    workspaceId: string,
    threads: ReadonlyArray<Pick<Thread, "id" | "workspaceId" | "messageCount">>,
  ): boolean {
    if (!validId(workspaceId)) return false;
    const state = this.session(workspaceId);
    if (!state) return false;
    let changed = false;
    for (const thread of threads) {
      if (thread.workspaceId !== workspaceId || !validId(thread.id)) continue;
      const count = validCount(thread.messageCount) ? thread.messageCount : 0;
      const current = state.counts.get(thread.id) ?? 0;
      if (count > current) {
        state.counts.set(thread.id, count);
        state.known.add(thread.id);
        changed = true;
      }
    }
    if (changed) this.persist(state);
    return changed;
  }

  // Handles a same-origin storage event for this app's read-state key. Counts only ever move
  // upward; lower stale events cannot resurrect unread. New thread keys from the other tab are
  // preserved. Because local read+write is not atomic across tabs, the event payload can be stale
  // while the current disk snapshot already holds the merged union; that union is absorbed into
  // memory here, and the disk is rewritten only when it is missing counts this tab already holds.
  // Deletion/corruption/unrelated keys are ignored so in-memory acknowledgements survive.
  syncStorage(key: string | null, newValue: string | null): boolean {
    if (typeof key !== "string" || newValue === null) return false;
    const workspaceId = parseReadStateKey(key);
    if (!workspaceId) return false;
    const state = this.sessions.get(workspaceId);
    if (!state) return false;
    const eventCounts = parseStoredPayload(newValue, workspaceId);
    if (!eventCounts) return false;
    let changed = this.mergeCounts(state, eventCounts);
    let needsRepair = false;
    for (const [threadId, count] of state.counts) {
      const eventCount = eventCounts.get(threadId);
      if (eventCount === undefined || eventCount < count) {
        needsRepair = true;
        break;
      }
    }
    if (!needsRepair) return changed;
    const saved = this.readValue(state.storageKey);
    const actual = saved !== null ? parseStoredPayload(saved, state.workspaceId) : null;
    if (actual) {
      changed = this.mergeCounts(state, actual) || changed;
      let diskCurrent = true;
      for (const [threadId, count] of state.counts) {
        const diskCount = actual.get(threadId);
        if (diskCount === undefined || diskCount < count) {
          diskCurrent = false;
          break;
        }
      }
      if (!diskCurrent) this.writeUnion(state);
    } else {
      this.writeUnion(state);
    }
    return changed;
  }
}
