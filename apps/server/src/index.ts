import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { HOST, hasWebBuild, PORT, SERVER_VERSION, WEB_DEV_URL } from "./config.js";
import { openServerStore } from "./store.js";
import { attachWebSocket } from "./ws.js";

const { store, seeded } = openServerStore();
const app = createApp(store);

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  const mode = hasWebBuild() ? "serving apps/web/dist" : `redirecting to ${WEB_DEV_URL}`;
  process.stdout.write(
    `nexestra server ${SERVER_VERSION} → http://${HOST}:${info.port}  (${mode})\n` +
      `  database  ${store.file}${seeded ? "  (seeded with mock data)" : ""}\n` +
      `  health    http://${HOST}:${info.port}/api/health\n` +
      `  api       http://${HOST}:${info.port}/api/workspaces\n` +
      `  websocket ws://${HOST}:${info.port}/ws\n`,
  );
}) as unknown as Server;

const wss = attachWebSocket(server, store);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    wss.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
