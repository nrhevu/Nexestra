import type { Server } from "node:http";
import {
  type NexestraEvent,
  WS_HEARTBEAT_INTERVAL_MS,
  type WsClientMessage,
  WsClientMessageSchema,
  type WsServerMessage,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { type WebSocket, WebSocketServer } from "ws";
import { SERVER_VERSION } from "./config.js";

interface Subscription {
  threads: Set<string>;
  workspaces: Set<string>;
  /** Cleared by the heartbeat; a socket that misses two pings is dropped. */
  alive: boolean;
}

/**
 * `/ws` — the realtime half of the API.
 *
 * A client sends `{type:"subscribe", threadId}` (and optionally a
 * `workspaceId`); the server pushes `{type:"event", event}` for every appended
 * event whose thread or workspace the client is subscribed to. One store-wide
 * listener fans out to every socket, so subscribing is O(1) and no listener
 * leaks when a socket goes away.
 */
export function attachWebSocket(server: Server, store: NexestraStore): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, Subscription>();

  const unsubscribeStore = store.events.subscribeAll((event) => {
    for (const [client, subscription] of subscriptions) {
      if (!matches(subscription, event)) continue;
      send(client, { type: "event", event });
    }
  });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (client: WebSocket) => {
    const subscription: Subscription = { threads: new Set(), workspaces: new Set(), alive: true };
    subscriptions.set(client, subscription);

    send(client, { type: "hello", serverVersion: SERVER_VERSION, at: new Date().toISOString() });

    client.on("pong", () => {
      subscription.alive = true;
    });

    client.on("message", (raw) => {
      const message = parseClientMessage(raw.toString());
      if (!message) {
        send(client, { type: "error", message: "unrecognised frame" });
        return;
      }
      handle(client, subscription, message);
    });

    client.on("close", () => subscriptions.delete(client));
    client.on("error", () => subscriptions.delete(client));
  });

  // Protocol-level heartbeat: a browser tab that goes away without a close
  // frame would otherwise keep its subscription forever.
  const heartbeat = setInterval(() => {
    for (const [client, subscription] of subscriptions) {
      if (!subscription.alive) {
        subscriptions.delete(client);
        client.terminate();
        continue;
      }
      subscription.alive = false;
      if (client.readyState === client.OPEN) client.ping();
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  wss.on("close", () => {
    clearInterval(heartbeat);
    unsubscribeStore();
  });

  return wss;
}

function handle(client: WebSocket, subscription: Subscription, message: WsClientMessage): void {
  switch (message.type) {
    case "subscribe":
      if (message.threadId) subscription.threads.add(message.threadId);
      if (message.workspaceId) subscription.workspaces.add(message.workspaceId);
      send(client, confirmation(subscription));
      break;
    case "unsubscribe":
      if (message.threadId) subscription.threads.delete(message.threadId);
      if (message.workspaceId) subscription.workspaces.delete(message.workspaceId);
      send(client, confirmation(subscription));
      break;
    case "ping":
      send(client, { type: "pong", at: new Date().toISOString() });
      break;
    default: {
      const exhaustive: never = message;
      throw new Error(`unhandled client frame ${JSON.stringify(exhaustive)}`);
    }
  }
}

function confirmation(subscription: Subscription): WsServerMessage {
  return {
    type: "subscribed",
    threadIds: [...subscription.threads],
    workspaceIds: [...subscription.workspaces],
  };
}

function matches(subscription: Subscription, event: NexestraEvent): boolean {
  if (event.threadId && subscription.threads.has(event.threadId)) return true;
  return subscription.workspaces.has(event.workspaceId);
}

function send(client: WebSocket, message: WsServerMessage): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
}

function parseClientMessage(raw: string): WsClientMessage | null {
  try {
    const parsed = WsClientMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
