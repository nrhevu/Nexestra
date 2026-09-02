import type { HealthResponse } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { hasWebBuild, SERVER_VERSION, WEB_DEV_URL } from "./config.js";
import { renderError } from "./errors.js";
import { ExecutionRuntime, type ExecutionRuntimeOptions } from "./execution/runtime.js";
import { createMasterLlm } from "./master/llm.js";
import { ProviderCredentialStore, providerCredentialPath } from "./master/provider-credentials.js";
import { MasterRunner, type MasterRunnerOptions } from "./master/runner.js";
import { agentRoutes } from "./routes/agents.js";
import { approvalRoutes } from "./routes/approvals.js";
import { artifactRoutes } from "./routes/artifacts.js";
import { executionRoutes } from "./routes/execution.js";
import { harnessRoutes } from "./routes/harnesses.js";
import { masterRoutes } from "./routes/master.js";
import { memoryRoutes } from "./routes/memories.js";
import { runRoutes } from "./routes/runs.js";
import { settingsRoutes } from "./routes/settings.js";
import { taskRoutes } from "./routes/tasks.js";
import { threadRoutes } from "./routes/threads.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { serveWebDist } from "./static.js";

export interface CreateAppOptions {
  /** Replace local provider credential persistence in tests. */
  readonly credentials?: ProviderCredentialStore;
  /** Replace outbound provider requests in tests. */
  readonly providerFetch?: typeof globalThis.fetch;
  /**
   * Replace the Master runtime — a test injects `createFakeLlmClient` here
   * rather than reaching into the module graph.
   */
  readonly master?: MasterRunner | Omit<MasterRunnerOptions, "store" | "execution">;
  /**
   * Replace the execution runtime. A test hands in an `ExecutionRuntime` built
   * on the fake adapter and a temp worktree root; production builds the real
   * one from the settings.
   */
  readonly execution?: ExecutionRuntime | Omit<ExecutionRuntimeOptions, "store">;
}

/**
 * The whole HTTP surface, plus the two runtimes behind it.
 *
 * Construction order matters and is circular on purpose: the Master needs an
 * `ExecutionHost` to dispatch work, and the orchestrator needs the Master to
 * replan and to move the thread's phase. The knot is tied by building the
 * execution runtime first (it works fine with no Master attached — it just
 * cannot change a phase) and calling `attachMaster()` once the runner exists.
 */
export function createApp(store: NexestraStore, options: CreateAppOptions = {}) {
  const credentials =
    options.credentials ?? new ProviderCredentialStore(providerCredentialPath(store.file));
  const execution = resolveExecution(store, options.execution);
  const runner = resolveRunner(
    store,
    options.master,
    execution,
    credentials,
    options.providerFetch,
  );
  execution.attachMaster(runner);

  const api = new Hono()
    .get("/health", (c) => {
      const health: HealthResponse = {
        ok: true,
        version: SERVER_VERSION,
        master: runner.runtime,
      };
      return c.json(health);
    })
    .route("/settings", settingsRoutes(store, runner, credentials, options.providerFetch))
    .route("/agents", agentRoutes(store))
    .route("/workspaces", workspaceRoutes(store))
    .route("/threads", threadRoutes(store))
    .route("/threads", masterRoutes(store, runner))
    .route("/threads", executionRoutes(store, execution))
    .route("/tasks", taskRoutes(store, execution))
    .route("/runs", runRoutes(store, execution))
    .route("/artifacts", artifactRoutes(store))
    .route("/approvals", approvalRoutes(store, runner))
    .route("/memories", memoryRoutes(store))
    .route("/harnesses", harnessRoutes(store, execution));

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

  return Object.assign(app, { master: runner, execution, credentials });
}

function resolveExecution(
  store: NexestraStore,
  execution: CreateAppOptions["execution"],
): ExecutionRuntime {
  if (execution instanceof ExecutionRuntime) return execution;
  return new ExecutionRuntime({ store, ...execution });
}

function resolveRunner(
  store: NexestraStore,
  master: CreateAppOptions["master"],
  execution: ExecutionRuntime,
  credentials: ProviderCredentialStore,
  providerFetch?: typeof globalThis.fetch,
): MasterRunner {
  if (master instanceof MasterRunner) return master;
  if (master) return new MasterRunner({ store, execution: execution.host, ...master });
  const runtime = createMasterLlm({
    settings: () => store.getSettings(),
    credentials,
    selection: (threadId) => {
      const agentId = store.getThread(threadId)?.agentId;
      const agent = agentId ? store.getAgent(agentId) : null;
      if (!agent?.enabled || agent.harness !== "nexestra" || !agent.providerId || !agent.model) {
        return undefined;
      }
      return {
        providerId: agent.providerId,
        model: agent.model,
        ...(agent.instructions ? { instructions: agent.instructions } : {}),
      };
    },
    ...(providerFetch ? { fetch: providerFetch } : {}),
  });
  return new MasterRunner({
    store,
    llm: runtime.client,
    runtime: (threadId) => runtime.info(threadId),
    execution: execution.host,
  });
}

export type NexestraApp = ReturnType<typeof createApp>;
