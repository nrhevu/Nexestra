import {
  type Message,
  type NexestraEvent,
  type Spec,
  type Task,
  type Thread,
  type WsClientMessage,
  type WsServerMessage,
  WsServerMessageSchema,
} from "@nexestra/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { keys } from "./api.js";

type Listener = (event: NexestraEvent) => void;

/**
 * One WebSocket for the whole tab.
 *
 * Subscriptions are reference-counted so several components can watch the same
 * thread; the socket reconnects with backoff and replays its subscription set,
 * so a server restart during development does not leave the UI stale.
 */
class EventsClient {
  private socket: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly threads = new Map<string, number>();
  private readonly workspaces = new Map<string, number>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    this.connect();
    return () => {
      this.listeners.delete(listener);
    };
  }

  watchThread(threadId: string): () => void {
    return this.watch(
      this.threads,
      threadId,
      (id) => ({ type: "subscribe", threadId: id }),
      (id) => ({
        type: "unsubscribe",
        threadId: id,
      }),
    );
  }

  watchWorkspace(workspaceId: string): () => void {
    return this.watch(
      this.workspaces,
      workspaceId,
      (id) => ({ type: "subscribe", workspaceId: id }),
      (id) => ({ type: "unsubscribe", workspaceId: id }),
    );
  }

  private watch(
    counts: Map<string, number>,
    id: string,
    subscribe: (id: string) => WsClientMessage,
    unsubscribe: (id: string) => WsClientMessage,
  ): () => void {
    this.connect();
    const next = (counts.get(id) ?? 0) + 1;
    counts.set(id, next);
    if (next === 1) this.send(subscribe(id));

    return () => {
      const remaining = (counts.get(id) ?? 1) - 1;
      if (remaining <= 0) {
        counts.delete(id);
        this.send(unsubscribe(id));
      } else {
        counts.set(id, remaining);
      }
    };
  }

  private connect(): void {
    if (this.socket || typeof window === "undefined") return;

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retry = 0;
      for (const threadId of this.threads.keys()) this.send({ type: "subscribe", threadId });
      for (const workspaceId of this.workspaces.keys()) {
        this.send({ type: "subscribe", workspaceId });
      }
    });

    socket.addEventListener("message", (frame) => {
      const message = parse(frame.data);
      if (message?.type !== "event") return;
      for (const listener of this.listeners) listener(message.event);
    });

    socket.addEventListener("close", () => {
      this.socket = null;
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => socket.close());
  }

  private scheduleReconnect(): void {
    if (this.timer || (this.listeners.size === 0 && this.threads.size === 0)) return;
    const delay = Math.min(1000 * 2 ** this.retry, 15_000);
    this.retry += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private send(message: WsClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

function parse(data: unknown): WsServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = WsServerMessageSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const eventsClient = new EventsClient();

/**
 * Subscribe to a thread (and its workspace) and fold incoming events into the
 * TanStack Query cache: entity snapshots are written straight in, everything
 * else invalidates the affected list.
 */
export function useThreadEvents(workspaceId: string, threadId: string): void {
  const client = useQueryClient();

  useEffect(() => {
    if (!threadId || !workspaceId) return;

    const stopThread = eventsClient.watchThread(threadId);
    const stopWorkspace = eventsClient.watchWorkspace(workspaceId);
    const stopListening = eventsClient.onEvent((event) => {
      applyEvent(client, workspaceId, event);
    });

    return () => {
      stopListening();
      stopThread();
      stopWorkspace();
    };
  }, [client, workspaceId, threadId]);
}

function applyEvent(
  client: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  event: NexestraEvent,
): void {
  const threadId = event.threadId;
  const invalidate = (queryKey: readonly unknown[]) => {
    void client.invalidateQueries({ queryKey });
  };

  switch (event.type) {
    case "message.added":
      if (!threadId) return;
      client.setQueryData<Message[]>(keys.messages(threadId), (current) =>
        upsert(current, event.payload as Message),
      );
      break;

    case "task.created":
    case "task.updated":
    case "task.status_changed":
      if (!threadId) return;
      client.setQueryData<Task[]>(keys.tasks(threadId), (current) =>
        upsert(current, event.payload as Task),
      );
      break;

    case "task.reordered":
    case "task.deleted":
      if (threadId) invalidate(keys.tasks(threadId));
      break;

    case "thread.created":
    case "thread.updated":
    case "thread.phase_changed":
      invalidate(keys.threads(workspaceId));
      if (threadId) {
        client.setQueryData<Thread>(keys.thread(threadId), event.payload as Thread);
      }
      break;

    case "spec.upserted":
    case "spec.frozen":
      if (threadId) client.setQueryData<Spec>(keys.spec(threadId), event.payload as Spec);
      break;

    case "plan.upserted":
      if (threadId) invalidate(keys.plan(threadId));
      break;

    case "run.recorded":
      if (threadId) invalidate(keys.runs(threadId));
      break;

    case "run.event_appended":
      if (event.runId) invalidate(keys.runEvents(event.runId));
      break;

    case "artifact.recorded":
      if (threadId) invalidate(keys.artifacts(threadId));
      break;

    case "approval.requested":
    case "approval.resolved":
      invalidate(keys.approvals(workspaceId));
      break;

    case "memory.upserted":
    case "memory.deleted":
    case "memory.linked":
    case "memory.unlinked":
      invalidate(keys.memories(workspaceId));
      break;

    case "workspace.created":
    case "workspace.updated":
      invalidate(keys.workspaces());
      break;

    case "settings.updated":
      invalidate(keys.settings());
      break;

    default:
      break;
  }
}

function upsert<T extends { id: string }>(current: T[] | undefined, row: T): T[] {
  const list = current ?? [];
  const index = list.findIndex((item) => item.id === row.id);
  if (index === -1) return [...list, row];
  return list.map((item, position) => (position === index ? row : item));
}
