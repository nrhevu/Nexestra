import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { HOST, hasWebBuild, PORT, SERVER_VERSION, WEB_DEV_URL } from "./config.js";
import { openServerStore } from "./store.js";
import { attachWebSocket } from "./ws.js";

const { store } = openServerStore();
const app = createApp(store);

/**
 * Repair anything a crash left behind *before* the first request lands: runs
 * that are still `running` in the database are marked `interrupted`, their
 * tasks are reset, and worktrees no live task claims are pruned
 * (`docs/orchestrator.md` §7.4).
 */
const recovered = await app.execution.recoverAll();
const detected = await app.execution.registry.list();

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  const mode = hasWebBuild() ? "serving apps/web/dist" : `redirecting to ${WEB_DEV_URL}`;
  const available = detected
    .filter((harness) => harness.available)
    .map((harness) => `${harness.id}@${harness.version ?? "?"}`)
    .join(", ");
  const harnesses = available || "none available — install codex or opencode";
  process.stdout.write(
    `nexestra server ${SERVER_VERSION} → http://${HOST}:${info.port}  (${mode})\n` +
      `  database  ${store.file}\n` +
      `  harnesses ${harnesses}\n` +
      (recovered.length > 0 ? `  recovered ${recovered.length} thread(s) after a restart\n` : "") +
      `  health    http://${HOST}:${info.port}/api/health\n` +
      `  api       http://${HOST}:${info.port}/api/workspaces\n` +
      `  websocket ws://${HOST}:${info.port}/ws\n`,
  );
}) as unknown as Server;

const wss = attachWebSocket(server, store);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    wss.close();
    // Cancels every live run — which kills the Codex process groups — and then
    // shuts down the OpenCode servers this process started.
    void app.execution
      .dispose()
      .catch(() => undefined)
      .finally(() => {
        server.close(() => {
          store.close();
          process.exit(0);
        });
      });
  });
}
