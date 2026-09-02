import type { HealthResponse } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { hasWebBuild, SERVER_VERSION, WEB_DEV_URL } from "./config.js";
import { renderError } from "./errors.js";
import { createMasterLlm } from "./master/llm.js";
import { MasterRunner, type MasterRunnerOptions } from "./master/runner.js";
import { approvalRoutes } from "./routes/approvals.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { masterRoutes } from "./routes/master.js";
import { memoryRoutes } from "./routes/memories.js";
import { placeholderRoutes } from "./routes/placeholders.js";
import { runRoutes } from "./routes/runs.js";
import { settingsRoutes } from "./routes/settings.js";
import { taskRoutes } from "./routes/tasks.js";
import { threadRoutes } from "./routes/threads.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { serveWebDist } from "./static.js";

export interface CreateAppOptions {
  /**
   * Replace the Master runtime — a test injects `createFakeLlmClient` and a
   * stub `ExecutionHost` here rather than reaching into the module graph.
   */
  readonly master?: MasterRunner | Omit<MasterRunnerOptions, "store">;
}

export function createApp(store: NexestraStore, options: CreateAppOptions = {}) {
  const runner = resolveRunner(store, options.master);

  const api = new Hono()
    .get("/health", (c) => {
      const health: HealthResponse = {
        ok: true,
        version: SERVER_VERSION,
        master: runner.runtime,
      };
      return c.json(health);
    })
    .route("/settings", settingsRoutes(store, runner))
    .route("/workspaces", workspaceRoutes(store))
    .route("/threads", threadRoutes(store))
    .route("/threads", masterRoutes(store, runner))
    .route("/tasks", taskRoutes(store))
    .route("/runs", runRoutes(store))
    .route("/artifacts", artifactRoutes(store))
    .route("/approvals", approvalRoutes(store, runner))
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

  return Object.assign(app, { master: runner });
}

function resolveRunner(store: NexestraStore, master: CreateAppOptions["master"]): MasterRunner {
  if (master instanceof MasterRunner) return master;
  if (master) return new MasterRunner({ store, ...master });
  const { client, info } = createMasterLlm();
  return new MasterRunner({ store, llm: client, runtime: info });
}

export type NexestraApp = ReturnType<typeof createApp>;
