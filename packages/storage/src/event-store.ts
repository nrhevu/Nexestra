import type { NexestraEvent, NexestraEventType } from "@nexestra/core";
import type Database from "better-sqlite3";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { NexestraDatabase } from "./db.js";
import { newId, now } from "./ids.js";
import { toEvent } from "./mappers.js";
import { events } from "./schema.js";

export interface AppendEventInput {
  workspaceId: string;
  threadId?: string;
  runId?: string;
  type: NexestraEventType;
  payload: unknown;
  /** Seeding replays historical rows verbatim; everything else omits these. */
  id?: string;
  createdAt?: string;
}

export type EventListener = (event: NexestraEvent) => void;

/**
 * Append-only log plus an in-process fan-out.
 *
 * Listeners fire only after the enclosing SQLite transaction has committed, so
 * a subscriber can never observe an event whose projection write was rolled
 * back. Use `transaction()` to group a projection write with its event.
 */
export class EventStore {
  private readonly listeners = new Set<{ target: string | null; listener: EventListener }>();
  private pending: NexestraEvent[] = [];
  private depth = 0;

  constructor(
    private readonly db: NexestraDatabase,
    private readonly sqlite: Database.Database,
  ) {}

  /**
   * Run `fn` inside one SQLite transaction. Nested calls join the outer
   * transaction. Events appended inside are emitted once, after the commit.
   */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();

    const run = this.sqlite.transaction(() => {
      this.depth += 1;
      try {
        return fn();
      } finally {
        this.depth -= 1;
      }
    });

    let result: T;
    try {
      result = run();
    } catch (error) {
      this.pending = [];
      throw error;
    }
    this.flush();
    return result;
  }

  /** Append one event. `seq` is assigned monotonically within the thread. */
  append(input: AppendEventInput): NexestraEvent {
    const event: NexestraEvent = {
      id: input.id ?? newId("ev"),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      runId: input.runId,
      seq: this.nextSeq(input.workspaceId, input.threadId),
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? now(),
    };

    this.db
      .insert(events)
      .values({
        id: event.id,
        workspaceId: event.workspaceId,
        threadId: event.threadId ?? null,
        runId: event.runId ?? null,
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      })
      .run();

    if (this.depth > 0) this.pending.push(event);
    else this.emit(event);

    return event;
  }

  /** Every event of a thread, oldest first, optionally after a known `seq`. */
  readThread(threadId: string, afterSeq?: number): NexestraEvent[] {
    const where =
      afterSeq === undefined
        ? eq(events.threadId, threadId)
        : and(eq(events.threadId, threadId), gt(events.seq, afterSeq));
    return this.db.select().from(events).where(where).orderBy(asc(events.seq)).all().map(toEvent);
  }

  /** Workspace-level events (those with no thread), oldest first. */
  readWorkspace(workspaceId: string, afterSeq?: number): NexestraEvent[] {
    const base = and(eq(events.workspaceId, workspaceId), isNull(events.threadId));
    const where = afterSeq === undefined ? base : and(base, gt(events.seq, afterSeq));
    return this.db.select().from(events).where(where).orderBy(asc(events.seq)).all().map(toEvent);
  }

  /**
   * Listen to a thread or a workspace. `target` is matched against both
   * `event.threadId` and `event.workspaceId`, so a workspace id also delivers
   * that workspace's thread events.
   */
  subscribe(target: string, listener: EventListener): () => void {
    const entry = { target, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Listen to every event in the store (used by the WebSocket registry). */
  subscribeAll(listener: EventListener): () => void {
    const entry = { target: null, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** Highest `seq` currently stored for a thread, or -1 when it has none. */
  latestSeq(workspaceId: string, threadId?: string): number {
    return this.nextSeq(workspaceId, threadId) - 1;
  }

  private nextSeq(workspaceId: string, threadId?: string): number {
    const where = threadId
      ? eq(events.threadId, threadId)
      : and(eq(events.workspaceId, workspaceId), isNull(events.threadId));
    const row = this.db
      .select({ max: sql<number | null>`max(${events.seq})` })
      .from(events)
      .where(where)
      .get();
    return (row?.max ?? -1) + 1;
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = [];
    for (const event of batch) this.emit(event);
  }

  private emit(event: NexestraEvent): void {
    for (const { target, listener } of this.listeners) {
      if (target !== null && target !== event.threadId && target !== event.workspaceId) continue;
      try {
        listener(event);
      } catch {
        // A broken subscriber must never roll back or stall the writer.
      }
    }
  }
}
