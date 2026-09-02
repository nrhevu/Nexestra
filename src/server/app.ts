import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { BootstrapData } from "../shared/contracts.js";
import { ChatGptAuthManager } from "./auth.js";
import { AgentDispatcher, ChatService } from "./dispatcher.js";
import { type AgentRunner, agentView, LocalAgentRunner } from "./runtime.js";
import { type FileStore, StoreError } from "./store.js";

interface CreateAppOptions {
  store: FileStore;
  runner?: AgentRunner;
  auth?: ChatGptAuthManager;
  productionAssets?: boolean;
}

export function createApp(options: CreateAppOptions) {
  const runner = options.runner ?? new LocalAgentRunner({ store: options.store });
  const dispatcher = new AgentDispatcher(options.store, runner);
  const chat = new ChatService(options.store, dispatcher);
  const localRunner = runner instanceof LocalAgentRunner ? runner : undefined;
  const auth =
    options.auth ?? (localRunner ? new ChatGptAuthManager(options.store, localRunner) : undefined);
  const app = new Hono();

  app.use("/api/*", async (context, next) => {
    if (context.req.method !== "GET" && context.req.method !== "HEAD") {
      const origin = context.req.header("origin");
      if (origin && !isLoopbackOrigin(origin)) {
        return context.json(
          { error: { code: "forbidden_origin", message: "Origin not allowed." } },
          403,
        );
      }
    }
    await next();
  });

  app.get("/api/health", (context) => context.json({ ok: true, version: "0.1.0" }));

  app.get("/api/bootstrap", async (context) => {
    const runtime = await runner.runtimeStatus();
    const workspaces = options.store.listWorkspaces();
    const requestedWorkspaceId = context.req.query("workspaceId");
    const workspace =
      (requestedWorkspaceId && options.store.getWorkspace(requestedWorkspaceId)) ?? workspaces[0];
    if (!workspace) throw new StoreError("not_found", "Workspace not found.");
    const data: BootstrapData = {
      workspaces,
      workspace,
      agents: options.store
        .listAgents(workspace.id)
        .map((agent) => agentView(agent, runtime, dispatcher.busyAgentIds())),
      threads: options.store.listThreads(workspace.id),
      tasks: options.store.listTasks(workspace.id),
      activeRuns: dispatcher.activeRuns(workspace.id),
      runtime,
      workspacePath: options.store.workspacePath,
      dataPath: options.store.root,
    };
    return context.json(data);
  });

  app.get("/api/activity", (context) => {
    const requestedWorkspaceId = context.req.query("workspaceId");
    const workspace =
      (requestedWorkspaceId && options.store.getWorkspace(requestedWorkspaceId)) ??
      options.store.listWorkspaces()[0];
    if (!workspace) throw new StoreError("not_found", "Workspace not found.");
    return context.json({ activeRuns: dispatcher.activeRuns(workspace.id) });
  });

  app.post("/api/workspaces", async (context) => {
    return context.json(await options.store.createWorkspace(await context.req.json()), 201);
  });

  app.post("/api/agents", async (context) => {
    const agent = await options.store.createAgent(await context.req.json());
    const runtime = await runner.runtimeStatus();
    return context.json(agentView(agent, runtime, dispatcher.busyAgentIds()), 201);
  });

  app.patch("/api/agents/:id", async (context) => {
    const agent = await options.store.updateAgent(
      context.req.param("id"),
      await context.req.json(),
    );
    const runtime = await runner.runtimeStatus();
    return context.json(agentView(agent, runtime, dispatcher.busyAgentIds()));
  });

  app.delete("/api/agents/:id", async (context) => {
    const agentId = context.req.param("id");
    if (!dispatcher.beginAgentDeletion(agentId)) {
      throw new StoreError(
        "conflict",
        "Wait for the agent's current work to finish before deleting it.",
      );
    }
    try {
      await options.store.deleteAgent(agentId);
      return context.body(null, 204);
    } finally {
      dispatcher.finishAgentDeletion(agentId);
    }
  });

  app.post("/api/threads", async (context) => {
    return context.json(await options.store.createThread(await context.req.json()), 201);
  });

  app.get("/api/threads/:id", async (context) => {
    return context.json(await options.store.threadData(context.req.param("id")));
  });

  app.post("/api/threads/:id/messages", async (context) => {
    return context.json(await chat.send(context.req.param("id"), await context.req.json()), 201);
  });

  app.post("/api/runs/:id/retry", async (context) => {
    return context.json(await dispatcher.retry(context.req.param("id")), 201);
  });

  app.post("/api/tasks", async (context) => {
    return context.json(await options.store.createTask(await context.req.json()), 201);
  });

  app.patch("/api/tasks/:id", async (context) => {
    return context.json(
      await options.store.updateTask(context.req.param("id"), await context.req.json()),
    );
  });

  app.post("/api/auth/chatgpt/start", async (context) => {
    if (!auth) throw new StoreError("invalid", "ChatGPT OAuth is unavailable in this runtime.");
    return context.json(await auth.start(), 201);
  });

  app.get("/api/auth/chatgpt/:id", async (context) => {
    if (!auth) throw new StoreError("invalid", "ChatGPT OAuth is unavailable in this runtime.");
    const session = await auth.get(context.req.param("id"));
    if (!session) throw new StoreError("not_found", "Login session not found.");
    return context.json(session);
  });

  app.delete("/api/auth/chatgpt/:id", (context) => {
    if (!auth) throw new StoreError("invalid", "ChatGPT OAuth is unavailable in this runtime.");
    const session = auth.cancel(context.req.param("id"));
    if (!session) throw new StoreError("not_found", "Login session not found.");
    return context.json(session);
  });

  app.notFound((context) => {
    if (isApiPath(context.req.path)) {
      return context.json({ error: { code: "not_found", message: "API route not found." } }, 404);
    }
    return context.text("Not found", 404);
  });

  app.onError((error, context) => {
    if (error instanceof ZodError) {
      return context.json(
        {
          error: {
            code: "invalid_request",
            message: error.issues[0]?.message ?? "Invalid data.",
          },
        },
        400,
      );
    }
    if (error instanceof StoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
      return context.json({ error: { code: error.code, message: error.message } }, status);
    }
    console.error(error);
    return context.json(
      { error: { code: "internal_error", message: error.message || "Server error." } },
      500,
    );
  });

  if (options.productionAssets) {
    app.use("/*", serveStatic({ root: "./dist/web" }));
    app.get("/*", async (context) => {
      if (isApiPath(context.req.path)) {
        return context.json({ error: { code: "not_found", message: "API route not found." } }, 404);
      }
      if (/\.[a-z0-9]+$/i.test(context.req.path)) return context.text("Not found", 404);
      return context.html(await readFile(join(process.cwd(), "dist/web/index.html"), "utf8"));
    });
  }

  return Object.assign(app, { dispatcher, runner });
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}
