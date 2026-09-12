import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ZodError } from "zod";
import {
  type BootstrapData,
  CreateKnowledgeFromMessageSchema,
  DelegateTaskSchema,
  MessageSearchRequestSchema,
  PruneKnowledgeRevisionsSchema,
  ReviewQueueRequestSchema,
  ReviewStatusUpdateSchema,
  RunHistoryRequestSchema,
  SelectRepositorySourceBranchSchema,
  ThreadHistoryRequestSchema,
  ToolAnswersSchema,
  UpdateAttentionStateSchema,
  UpdateWorkspaceWhiteboardSchema,
} from "../shared/contracts.js";
import { reviewAssignmentGit } from "./assignment-review.js";
import { workspaceActivity } from "./attention.js";
import { ChatGptAuthManager } from "./auth.js";
import { AgentDispatcher, ChatService } from "./dispatcher.js";
import { loadHarnessConfig } from "./harness-config.js";
import { type AssignmentRepositoryManager, RepositoryManager } from "./repository-manager.js";
import { type AgentRunner, agentView, LocalAgentRunner } from "./runtime.js";
import {
  type FileStore,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
  StoreError,
  type UploadArtifactInput,
} from "./store.js";
import { createWorkspaceExportResponse } from "./workspace-export.js";

interface CreateAppOptions {
  store: FileStore;
  runner?: AgentRunner;
  auth?: ChatGptAuthManager;
  productionAssets?: boolean;
  launchPath?: (path: string, reveal: boolean) => Promise<void>;
  repositories?: AssignmentRepositoryManager;
}

export function createApp(options: CreateAppOptions) {
  const runner = options.runner ?? new LocalAgentRunner({ store: options.store });
  const defaultRepositories = new RepositoryManager(options.store);
  const repositories = options.repositories ?? defaultRepositories;
  const dispatcher = new AgentDispatcher(options.store, runner, repositories);
  const chat = new ChatService(options.store, dispatcher);
  const launchPath = options.launchPath ?? launchDesktopPath;
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
    const workspaces = options.store.listWorkspaces();
    const requestedWorkspaceId = context.req.query("workspaceId");
    const workspace =
      requestedWorkspaceId === undefined
        ? workspaces[0]
        : options.store.getWorkspace(requestedWorkspaceId);
    if (!workspace) throw new StoreError("not_found", "Workspace not found.");
    const runtime = await runner.runtimeStatus();
    const harnessConfig = await loadHarnessConfig(options.store.workspacePath);
    const customSurfaces = harnessConfig.surfaces.map((surface) => ({
      ...surface,
      title: options.store.redactSecrets(surface.title),
      description: options.store.redactSecrets(surface.description),
      cards: surface.cards.map((card) => ({
        ...card,
        title: options.store.redactSecrets(card.title),
        description: options.store.redactSecrets(card.description),
      })),
    }));
    const activity = workspaceActivity(
      options.store,
      workspace.id,
      dispatcher.activeRuns(workspace.id),
    );
    const data: BootstrapData = {
      workspaces,
      workspace,
      agents: options.store
        .listAgents(workspace.id)
        .map((agent) => agentView(agent, runtime, dispatcher.busyAgentIds())),
      threads: options.store.listThreads(workspace.id),
      tasks: options.store.listTasks(workspace.id),
      knowledge: options.store.listKnowledge(workspace.id),
      customSurfaces,
      assignments: options.store.listAssignments(workspace.id),
      activeRuns: activity.activeRuns,
      attention: activity.attention,
      workspaceActivitySummaries: workspaces.map((entry) => {
        const summary = workspaceActivity(options.store, entry.id, dispatcher.activeRuns(entry.id));
        return {
          workspaceId: entry.id,
          attentionCount: summary.attention.length,
          activeRunCount: summary.activeRuns.length,
        };
      }),
      runtime,
      workspacePath: options.store.workspacePath,
      dataPath: options.store.root,
    };
    return context.json(data);
  });

  app.get("/api/activity", (context) => {
    const requestedWorkspaceId = context.req.query("workspaceId");
    const workspace =
      requestedWorkspaceId === undefined
        ? options.store.listWorkspaces()[0]
        : options.store.getWorkspace(requestedWorkspaceId);
    if (!workspace) throw new StoreError("not_found", "Workspace not found.");
    return context.json(
      workspaceActivity(options.store, workspace.id, dispatcher.activeRuns(workspace.id)),
    );
  });

  app.post("/api/attention/:id/state", async (context) => {
    const workspaceId = context.req.query("workspaceId");
    return context.json(
      await options.store.updateAttentionState(
        workspaceId || undefined,
        context.req.param("id"),
        UpdateAttentionStateSchema.parse(await context.req.json()),
      ),
    );
  });

  app.get("/api/whiteboard", async (context) => {
    const workspaceId = context.req.query("workspaceId");
    return context.json(await options.store.getWorkspaceWhiteboard(workspaceId || undefined));
  });

  app.put("/api/whiteboard", async (context) => {
    const workspaceId = context.req.query("workspaceId");
    return context.json(
      await options.store.updateWorkspaceWhiteboard(
        workspaceId || undefined,
        UpdateWorkspaceWhiteboardSchema.parse(await context.req.json()),
      ),
    );
  });

  app.get("/api/workspaces", (context) => context.json(options.store.listWorkspaces()));

  app.post("/api/workspaces", async (context) => {
    return context.json(await options.store.createWorkspace(await context.req.json()), 201);
  });

  app.patch("/api/workspaces/:id", async (context) => {
    return context.json(
      await options.store.updateWorkspace(context.req.param("id"), await context.req.json()),
    );
  });

  app.put("/api/workspaces/order", async (context) => {
    return context.json(await options.store.reorderWorkspaces(await context.req.json()));
  });

  app.get("/api/workspaces/:id/export", async (context) => {
    if (Object.keys(context.req.query()).length > 0) {
      throw new StoreError("invalid", "Workspace export does not accept query options.");
    }
    return createWorkspaceExportResponse({
      store: options.store,
      workspaceId: context.req.param("id"),
      signal: context.req.raw.signal,
    });
  });

  app.post("/api/agents", async (context) => {
    const agent = await options.store.createAgent(await context.req.json());
    const runtime = await runner.runtimeStatus();
    return context.json(agentView(agent, runtime, dispatcher.busyAgentIds()), 201);
  });

  app.post("/api/knowledge/documents", async (context) => {
    const body = await context.req.parseBody({
      all: true,
      maxFiles: MAX_UPLOAD_FILES,
      maxFileSize: MAX_UPLOAD_BYTES,
      maxSize: MAX_UPLOAD_TOTAL_BYTES,
    });
    const files = toFiles(body.file);
    if (files.length !== 1) {
      throw new StoreError("invalid", "Choose exactly one knowledge document.");
    }
    validateFileHeaders(files);
    const file = files[0];
    if (!file) throw new StoreError("invalid", "Knowledge document is missing.");
    return context.json(
      await options.store.createKnowledgeDocument(
        {
          workspaceId: stringField(body.workspaceId),
          name: stringField(body.name),
          handle: stringField(body.handle),
          description: stringField(body.description),
        },
        {
          name: file.name,
          mediaType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        },
      ),
      201,
    );
  });

  app.post("/api/knowledge/from-message", async (context) => {
    const input = CreateKnowledgeFromMessageSchema.parse(await context.req.json());
    return context.json(await options.store.createKnowledgeDocumentFromMessage(input), 201);
  });

  app.put("/api/knowledge/:id/document", async (context) => {
    const body = await context.req.parseBody({
      all: true,
      maxFiles: 1,
      maxFileSize: MAX_UPLOAD_BYTES,
      maxSize: MAX_UPLOAD_TOTAL_BYTES,
    });
    const files = toFiles(body.file);
    if (files.length !== 1) {
      throw new StoreError("invalid", "Choose exactly one replacement document.");
    }
    validateFileHeaders(files);
    const file = files[0];
    if (!file) throw new StoreError("invalid", "Replacement document is missing.");
    return context.json(
      await options.store.replaceKnowledgeDocument(
        context.req.param("id"),
        { expectedRevisionId: stringField(body.expectedRevisionId) },
        {
          name: file.name,
          mediaType: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        },
      ),
    );
  });

  app.post("/api/knowledge/repositories", async (context) => {
    return context.json(await defaultRepositories.addRepository(await context.req.json()), 201);
  });

  app.post("/api/knowledge/repositories/:id/retry", async (context) => {
    return context.json(await defaultRepositories.retryRepository(context.req.param("id")));
  });

  app.post("/api/knowledge/repositories/:id/refresh", async (context) => {
    return context.json(await defaultRepositories.refreshRepository(context.req.param("id")));
  });

  app.get("/api/knowledge/:id/branches", async (context) => {
    return context.json(await defaultRepositories.listBranches(context.req.param("id")));
  });

  app.post("/api/knowledge/:id/source-branch", async (context) => {
    const input = SelectRepositorySourceBranchSchema.parse(await context.req.json());
    return context.json(
      await defaultRepositories.selectSourceBranch(context.req.param("id"), input),
    );
  });

  app.get("/api/knowledge/:id", (context) => {
    const item = options.store.getKnowledge(context.req.param("id"));
    if (!item) throw new StoreError("not_found", "Knowledge item not found.");
    return context.json(item);
  });

  app.patch("/api/knowledge/:id", async (context) => {
    return context.json(
      await options.store.updateKnowledge(context.req.param("id"), await context.req.json()),
    );
  });

  app.delete("/api/knowledge/:id", async (context) => {
    await options.store.deleteKnowledge(context.req.param("id"));
    return context.body(null, 204);
  });

  app.get("/api/knowledge/:id/content", async (context) => {
    const item = options.store.getKnowledge(context.req.param("id"));
    if (item?.kind !== "document") {
      throw new StoreError("not_found", "Knowledge document not found.");
    }
    const bytes = item.currentRevisionId
      ? (await options.store.documentRevisionContent(item.id, item.currentRevisionId)).bytes
      : await readFile(options.store.knowledgePath(item));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`,
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.get("/api/knowledge/:id/revisions", async (context) => {
    return context.json(
      await options.store.listKnowledgeDocumentRevisions(context.req.param("id")),
    );
  });

  app.post("/api/knowledge/:id/revisions/prune", async (context) => {
    return context.json(
      await options.store.pruneKnowledgeDocumentRevisions(
        context.req.param("id"),
        PruneKnowledgeRevisionsSchema.parse(await context.req.json()),
      ),
    );
  });

  app.get("/api/knowledge/:id/preview", async (context) => {
    const revisionId = context.req.query("revisionId");
    return context.json(
      await options.store.previewKnowledgeDocument(
        context.req.param("id"),
        revisionId === undefined || revisionId === "" ? undefined : revisionId,
      ),
    );
  });

  app.get("/api/knowledge/:id/revisions/:revisionId/content", async (context) => {
    const { revision, bytes } = await options.store.documentRevisionContent(
      context.req.param("id"),
      context.req.param("revisionId"),
    );
    return new Response(new Blob([bytes]), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(revision.fileName)}`,
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post("/api/knowledge/:id/revisions/:revisionId/restore", async (context) => {
    return context.json(
      await options.store.restoreKnowledgeDocumentRevision(
        context.req.param("id"),
        context.req.param("revisionId"),
        await context.req.json(),
      ),
    );
  });

  app.patch("/api/agents/:id", async (context) => {
    const agent = await dispatcher.updateAgent(context.req.param("id"), await context.req.json());
    const runtime = await runner.runtimeStatus();
    return context.json(agentView(agent, runtime, dispatcher.busyAgentIds()));
  });

  app.delete("/api/agents/:id", async (context) => {
    const agentId = context.req.param("id");
    if (!dispatcher.beginAgentMutation(agentId)) {
      throw new StoreError(
        "conflict",
        "Wait for the agent's current work or configuration change to finish before deleting it.",
      );
    }
    try {
      await options.store.deleteAgent(agentId);
      return context.body(null, 204);
    } finally {
      dispatcher.finishAgentMutation(agentId);
    }
  });

  app.post("/api/threads", async (context) => {
    return context.json(await options.store.createThread(await context.req.json()), 201);
  });

  app.patch("/api/threads/:id", async (context) => {
    return context.json(
      await options.store.renameThread(context.req.param("id"), await context.req.json()),
    );
  });

  app.post("/api/threads/:id/archive", async (context) => {
    return context.json(await dispatcher.archiveThread(context.req.param("id")));
  });

  app.post("/api/threads/:id/restore", async (context) => {
    return context.json(await options.store.restoreThread(context.req.param("id")));
  });

  app.get("/api/search/messages", async (context) => {
    const query = MessageSearchRequestSchema.parse(context.req.query());
    return context.json(await options.store.searchMessages(query));
  });

  app.get("/api/runs", async (context) => {
    const input = RunHistoryRequestSchema.parse(context.req.query());
    return context.json(await options.store.listRunHistory(input));
  });

  app.get("/api/reviews", async (context) => {
    const input = ReviewQueueRequestSchema.parse(context.req.query());
    return context.json(await options.store.listReviewQueue(input));
  });

  app.patch("/api/reviews/:threadId/:messageId", async (context) => {
    const status = ReviewStatusUpdateSchema.parse(await context.req.json());
    return context.json(
      await options.store.setMessageReviewStatus(
        context.req.param("threadId"),
        context.req.param("messageId"),
        status,
      ),
    );
  });

  app.get("/api/threads/:id/history", async (context) => {
    const threadId = context.req.param("id");
    const input = ThreadHistoryRequestSchema.parse(context.req.query());
    const thread = options.store.getThread(threadId);
    if (!thread || thread.workspaceId !== input.workspaceId) {
      throw new StoreError("not_found", "Thread not found in this workspace.");
    }
    const activeRuns = dispatcher
      .activeRuns(thread.workspaceId)
      .filter((run) => run.threadId === threadId);
    return context.json(
      await options.store.historyPage(input.workspaceId, threadId, input, activeRuns),
    );
  });

  app.get("/api/threads/:id/metadata", (context) => {
    const threadId = context.req.param("id");
    const thread = options.store.getThread(threadId);
    if (!thread) throw new StoreError("not_found", "Thread not found.");
    const redact = (value: string) => options.store.redactSecrets(value);
    return context.json({ ...thread, name: redact(thread.name), slug: redact(thread.slug) });
  });

  app.get("/api/threads/:id", async (context) => {
    return context.json(await options.store.threadData(context.req.param("id")));
  });

  app.put("/api/threads/:id/messages/:messageId/feedback", async (context) => {
    const feedback = await options.store.setMessageFeedback(
      context.req.param("id"),
      context.req.param("messageId"),
      await context.req.json(),
    );
    return context.json(feedback);
  });

  app.get("/api/threads/:id/export", async (context) => {
    const threadId = context.req.param("id");
    const thread = options.store.getThread(threadId);
    if (!thread) throw new StoreError("not_found", "Thread not found.");
    const markdown = await options.store.exportThreadMarkdown(threadId);
    return new Response(markdown, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${thread.slug}.md`)}`,
        "cache-control": "private, no-store",
      },
    });
  });

  app.get("/api/threads/:id/events", (context) => {
    const threadId = context.req.param("id");
    if (!options.store.getThread(threadId)) {
      throw new StoreError("not_found", "Thread not found.");
    }
    return streamSSE(context, async (stream) => {
      let writes = Promise.resolve();
      const send = (event: ReturnType<typeof dispatcher.threadStreamSnapshot>) => {
        writes = writes
          .then(() => stream.writeSSE({ event: "thread", data: JSON.stringify(event) }))
          .catch(() => stream.abort());
      };
      send(dispatcher.threadStreamSnapshot(threadId));
      const unsubscribe = dispatcher.subscribeThread(threadId, send);
      try {
        await new Promise<void>((resolve) => stream.onAbort(resolve));
      } finally {
        unsubscribe();
      }
    });
  });

  app.post("/api/threads/:id/messages", async (context) => {
    const contentType = context.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
      const result = await chat.send(context.req.param("id"), await context.req.json());
      return context.json(result, result.replayed ? 200 : 201);
    }
    const body = await context.req.parseBody({
      all: true,
      maxFiles: MAX_UPLOAD_FILES,
      maxFileSize: MAX_UPLOAD_BYTES,
      maxSize: MAX_UPLOAD_TOTAL_BYTES,
    });
    const content = typeof body.content === "string" ? body.content : "";
    const files = toFiles(body.files);
    validateFileHeaders(files);
    const uploads: UploadArtifactInput[] = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        mediaType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    const raw = body.requestId === undefined ? { content } : { content, requestId: body.requestId };
    const result = await chat.send(context.req.param("id"), raw, uploads);
    return context.json(result, result.replayed ? 200 : 201);
  });

  app.get("/api/threads/:threadId/artifacts/:artifactId/content", async (context) => {
    const { artifact, file } = await options.store.artifactContent(
      context.req.param("threadId"),
      context.req.param("artifactId"),
    );
    const bytes = await readFile(file);
    const inline =
      artifact.kind === "image" &&
      isSafeImageMediaType(artifact.mediaType) &&
      context.req.query("download") !== "1";
    const mediaType = inline
      ? (artifact.mediaType ?? "application/octet-stream")
      : "application/octet-stream";
    return new Response(new Uint8Array(bytes), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
        "content-type": mediaType,
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.post("/api/runs/:id/retry", async (context) => {
    return context.json(await dispatcher.retry(context.req.param("id")), 201);
  });

  app.post("/api/runs/:id/stop", async (context) => {
    return context.json(await dispatcher.stopRun(context.req.param("id")));
  });

  app.post("/api/tool-calls/:id/approve", (context) => {
    dispatcher.resolveToolApproval(context.req.param("id"), true);
    return context.body(null, 204);
  });

  app.post("/api/tool-calls/:id/deny", (context) => {
    dispatcher.resolveToolApproval(context.req.param("id"), false);
    return context.body(null, 204);
  });

  app.post("/api/tool-calls/:id/respond", async (context) => {
    const { answers } = ToolAnswersSchema.parse(await context.req.json());
    dispatcher.resolveToolInput(context.req.param("id"), answers);
    return context.body(null, 204);
  });

  app.post("/api/tasks", async (context) => {
    return context.json(await options.store.createTask(await context.req.json()), 201);
  });

  app.get("/api/tasks/:id", (context) => {
    const task = options.store.getTask(context.req.param("id"));
    if (!task) throw new StoreError("not_found", "Task not found.");
    return context.json(task);
  });

  app.get("/api/tasks/:id/process", async (context) => {
    return context.json(await dispatcher.taskProcess(context.req.param("id")));
  });

  app.post("/api/tasks/:id/stop", async (context) => {
    return context.json(await dispatcher.stopTask(context.req.param("id")));
  });

  app.post("/api/assignments/:id/open", async (context) => {
    const worktreePath = assignmentWorktreePath(options.store, context.req.param("id"));
    await launchPath(worktreePath, false);
    return context.body(null, 204);
  });

  app.post("/api/assignments/:id/reveal", async (context) => {
    const worktreePath = assignmentWorktreePath(options.store, context.req.param("id"));
    await launchPath(worktreePath, true);
    return context.body(null, 204);
  });

  app.get("/api/assignments/:id/review", async (context) => {
    return context.json(await reviewAssignmentGit(options.store, context.req.param("id")));
  });

  app.post("/api/assignments/:id/cleanup", async (context) => {
    const assignmentId = context.req.param("id");
    const assignment = options.store.listAssignments().find((entry) => entry.id === assignmentId);
    if (!assignment) throw new StoreError("not_found", "Assignment not found.");
    if (assignment.status === "queued" || assignment.status === "running") {
      throw new StoreError("conflict", "Wait for the Worker assignment to finish before cleanup.");
    }
    if (assignment.worktreeCleanedAt) {
      throw new StoreError("conflict", "This Worker worktree has already been cleaned up.");
    }
    const knowledge = options.store.getKnowledge(assignment.repositoryId);
    if (knowledge?.kind !== "repository") {
      throw new StoreError("invalid", "The assignment repository is unavailable.");
    }
    const absolutePath = assignmentWorktreePath(options.store, assignment.id);
    await repositories.cleanupAssignment(knowledge, {
      branch: assignment.branch,
      worktreePath: assignment.worktreePath,
      absolutePath,
    });
    return context.json(
      await options.store.updateAssignment(assignment.id, {
        worktreeCleanedAt: new Date().toISOString(),
      }),
    );
  });

  app.post("/api/assignments/:id/branch", async (context) => {
    const assignmentId = context.req.param("id");
    const assignment = options.store.listAssignments().find((entry) => entry.id === assignmentId);
    if (!assignment) throw new StoreError("not_found", "Assignment not found.");
    if (assignment.status === "queued" || assignment.status === "running") {
      throw new StoreError("conflict", "Wait for the Worker assignment to finish first.");
    }
    if (!assignment.worktreeCleanedAt) {
      throw new StoreError("conflict", "Remove this Worker worktree before deleting its branch.");
    }
    if (assignment.branchDeletedAt) {
      throw new StoreError("conflict", "This Worker branch has already been deleted.");
    }
    const knowledge = options.store.getKnowledge(assignment.repositoryId);
    if (knowledge?.kind !== "repository") {
      throw new StoreError("invalid", "The assignment repository is unavailable.");
    }
    const absolutePath = assignmentWorktreePath(options.store, assignment.id);
    await repositories.deleteAssignmentBranch(knowledge, {
      branch: assignment.branch,
      worktreePath: assignment.worktreePath,
      absolutePath,
    });
    return context.json(
      await options.store.updateAssignment(assignment.id, {
        branchDeletedAt: new Date().toISOString(),
      }),
    );
  });

  app.patch("/api/tasks/:id", async (context) => {
    return context.json(
      await options.store.updateTask(context.req.param("id"), await context.req.json()),
    );
  });

  app.delete("/api/tasks/:id", async (context) => {
    await options.store.deleteTask(context.req.param("id"));
    return context.body(null, 204);
  });

  app.post("/api/tasks/:taskId/delegate", async (context) => {
    const taskId = context.req.param("taskId");
    const { workerHandle, repositoryHandle } = DelegateTaskSchema.parse(await context.req.json());
    return context.json(
      await dispatcher.delegateFromTask(taskId, workerHandle, repositoryHandle),
      202,
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
            message: options.store.redactSecrets(error.issues[0]?.message ?? "Invalid data."),
          },
        },
        400,
      );
    }
    if (error instanceof StoreError) {
      const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
      return context.json(
        { error: { code: error.code, message: options.store.redactSecrets(error.message) } },
        status,
      );
    }
    const message = options.store.redactSecrets(error.message || "Server error.");
    // Log only redacted text: Error objects can expose secrets through stack or cause fields.
    console.error(options.store.redactSecrets(error.stack ?? message));
    return context.json({ error: { code: "internal_error", message } }, 500);
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

function toFiles(value: string | File | (string | File)[] | undefined): File[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (values.some((entry) => !(entry instanceof File))) {
    throw new StoreError("invalid", "Attachments must be uploaded as files.");
  }
  return values as File[];
}

function stringField(value: string | File | (string | File)[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function validateFileHeaders(files: File[]): void {
  if (files.length > MAX_UPLOAD_FILES) {
    throw new StoreError("invalid", `Attach no more than ${MAX_UPLOAD_FILES} files at once.`);
  }
  if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
    throw new StoreError("invalid", "Each attachment must be 20 MB or smaller.");
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
    throw new StoreError("invalid", "Attachments must be 50 MB or smaller in total.");
  }
}

function isSafeImageMediaType(mediaType?: string): boolean {
  return ["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"].includes(
    mediaType ?? "",
  );
}

function assignmentWorktreePath(store: FileStore, assignmentId: string): string {
  const assignment = store.listAssignments().find((entry) => entry.id === assignmentId);
  if (!assignment) throw new StoreError("not_found", "Assignment not found.");
  const root = resolve(store.root);
  const worktreePath = resolve(root, assignment.worktreePath);
  if (worktreePath !== root && !worktreePath.startsWith(`${root}${sep}`)) {
    throw new StoreError("invalid", "Assignment worktree path is outside the data directory.");
  }
  return worktreePath;
}

async function launchDesktopPath(path: string, reveal: boolean): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", reveal ? ["-R", path] : [path]]
      : process.platform === "win32"
        ? ["explorer.exe", reveal ? [`/select,${path}`] : [path]]
        : ["xdg-open", [reveal ? dirname(path) : path]];
  await new Promise<void>((resolveLaunch, rejectLaunch) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Desktop launcher timed out."));
    }, 15_000);
    timeout.unref();
    child.once("error", finish);
    child.once("close", (code) => {
      finish(code === 0 ? undefined : new Error(`Desktop launcher exited with code ${code ?? 1}.`));
    });

    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectLaunch(error);
      else resolveLaunch();
    }
  });
}
