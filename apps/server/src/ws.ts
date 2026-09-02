import type { Server } from "node:http";
import { type ClientFrame, ClientFrameSchema, type ServerFrame } from "@nexestra/core";
import { type WebSocket, WebSocketServer } from "ws";
import { SERVER_VERSION } from "./config.js";

/**
 * `/ws` accepts connections and sends a `hello` frame. Real run-event fan-out
 * lands in M1 once the event store exists.
 */
export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

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
    send(client, { type: "hello", serverVersion: SERVER_VERSION, at: new Date().toISOString() });

    client.on("message", (raw) => {
      const frame = parseClientFrame(raw.toString());
      if (frame?.type === "ping") {
        send(client, { type: "pong", at: new Date().toISOString() });
      }
      // `subscribe` / `unsubscribe` are accepted and ignored until M1.
    });
  });

  return wss;
}

function send(client: WebSocket, frame: ServerFrame): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(frame));
}

function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const parsed = ClientFrameSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
