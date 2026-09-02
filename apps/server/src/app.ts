import type { HealthResponse } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { hasWebBuild, SERVER_VERSION, WEB_DEV_URL } from "./config.js";
import { renderError } from "./errors.js";
import { approvalRoutes } from "./routes/approvals.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { memoryRoutes } from "./routes/memories.js";
import { placeholderRoutes } from "./routes/placeholders.js";
import { runRoutes } from "./routes/runs.js";
import { settingsRoutes } from "./routes/settings.js";
import { taskRoutes } from "./routes/tasks.js";
import { threadRoutes } from "./routes/threads.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { serveWebDist } from "./static.js";

export function createApp(store: NexestraStore) {
  const api = new Hono()
    .get("/health", (c) => {
      const health: HealthResponse = { ok: true, version: SERVER_VERSION };
      return c.json(health);
    })
    .route("/settings", settingsRoutes(store))
    .route("/workspaces", workspaceRoutes(store))
    .route("/threads", threadRoutes(store))
    .route("/tasks", taskRoutes(store))
    .route("/runs", runRoutes(store))
    .route("/artifacts", artifactRoutes(store))
    .route("/approvals", approvalRoutes(store))
    .route("/memories", memoryRoutes(store))
    .route("/", placeholderRoutes);

  const app = new Hono().route("/api", api);

  app.onError(renderError);

  app.notFound(async (c) => {
    if (c.req.path.startsWith("/api/")) {
      return c.json({ error: { code: "not_found", message: `no route for ${c.req.path}` } }, 404);
    }
    // In production the SPA is served from apps/web/dist; in dev it lives on
    // the Vite server, so bounce the browser there.
    if (hasWebBuild()) return serveWebDist(c);
    return c.redirect(`${WEB_DEV_URL}${c.req.path}`, 302);
  });

  return app;
}

export type NexestraApp = ReturnType<typeof createApp>;
