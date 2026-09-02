import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type WsServerMessage, WsServerMessageSchema } from "@nexestra/core";
import { createStore, type NexestraStore } from "@nexestra/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app.js";
import { attachWebSocket } from "./ws.js";

let home: string;
let store: NexestraStore;
let server: Server;
let url: string;
let sockets: WebSocket[] = [];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "nexestra-ws-"));
  store = createStore({ path: join(home, "nexestra.db"), dataDir: join(home, "data") });
  server = serve({
    fetch: createApp(store).fetch,
    hostname: "127.0.0.1",
    port: 0,
  }) as unknown as Server;
  attachWebSocket(server, store);
  await new Promise((resolve) => server.once("listening", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets = [];
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** Connect and collect every server message in arrival order. */
async function connect(): Promise<{ socket: WebSocket; received: WsServerMessage[] }> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const received: WsServerMessage[] = [];
  socket.on("message", (raw) => {
    const parsed = WsServerMessageSchema.safeParse(JSON.parse(raw.toString()));
    if (parsed.success) received.push(parsed.data);
  });
  await new Promise((resolve) => socket.once("open", resolve));
  return { socket, received };
}

/** Wait until `predicate` holds, or fail the test after ~1s. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

describe("/ws", () => {
  it("greets, answers ping and confirms subscriptions", async () => {
    const { socket, received } = await connect();
    await until(() => received.length === 1);
    expect(received[0]?.type).toBe("hello");

    socket.send(JSON.stringify({ type: "ping" }));
    await until(() => received.some((message) => message.type === "pong"));
  });

  it("pushes events of subscribed threads only", async () => {
    const workspace = store.createWorkspace({ name: "demo", rootPath: "/tmp/demo" });
    const watched = store.createThread({ workspaceId: workspace.id, title: "watched" });
    const other = store.createThread({ workspaceId: workspace.id, title: "other" });

    const { socket, received } = await connect();
    await until(() => received.length === 1);

    socket.send(JSON.stringify({ type: "subscribe", threadId: watched.id }));
    await until(() => received.some((message) => message.type === "subscribed"));

    store.addMessage({ threadId: other.id, content: "invisible" });
    store.addMessage({ threadId: watched.id, content: "visible" });

    await until(() => received.some((message) => message.type === "event"));
    const events = received.filter((message) => message.type === "event");
    expect(events).toHaveLength(1);
    expect(events[0]?.event.threadId).toBe(watched.id);
    expect(events[0]?.event.type).toBe("message.added");
  });

  it("delivers workspace-level events to a workspace subscriber", async () => {
    const workspace = store.createWorkspace({ name: "demo", rootPath: "/tmp/demo" });

    const { socket, received } = await connect();
    await until(() => received.length === 1);
    socket.send(JSON.stringify({ type: "subscribe", workspaceId: workspace.id }));
    await until(() => received.some((message) => message.type === "subscribed"));

    store.createThread({ workspaceId: workspace.id, title: "fresh" });

    await until(() => received.some((message) => message.type === "event"));
    const [event] = received.filter((message) => message.type === "event");
    expect(event?.event.type).toBe("thread.created");
  });

  it("stops pushing after unsubscribe", async () => {
    const workspace = store.createWorkspace({ name: "demo", rootPath: "/tmp/demo" });
    const thread = store.createThread({ workspaceId: workspace.id, title: "watched" });

    const { socket, received } = await connect();
    await until(() => received.length === 1);
    socket.send(JSON.stringify({ type: "subscribe", threadId: thread.id }));
    await until(() => received.some((message) => message.type === "subscribed"));

    socket.send(JSON.stringify({ type: "unsubscribe", threadId: thread.id }));
    await until(() => received.filter((message) => message.type === "subscribed").length === 2);

    store.addMessage({ threadId: thread.id, content: "after unsubscribe" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((message) => message.type === "event")).toHaveLength(0);
  });
});
