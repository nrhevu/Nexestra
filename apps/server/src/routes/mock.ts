import {
  mockApprovals,
  mockArtifacts,
  mockBundle,
  mockFileContents,
  mockFileTree,
  mockHarnesses,
  mockMemories,
  mockMessages,
  mockPlans,
  mockRunEvents,
  mockRuns,
  mockSpecs,
  mockTasks,
  mockTerminalLines,
  mockThreads,
  mockWorkspaces,
} from "@nexestra/core/mock";
import { Hono } from "hono";

/**
 * Read-only mock API. M0 has no store, so every route slices the fixtures from
 * `@nexestra/core/mock`. M1 replaces these handlers with the projection reads
 * while keeping the same shapes.
 */
export const mockRoutes = new Hono()
  .get("/", (c) => c.json(mockBundle))

  .get("/workspaces", (c) => c.json(mockWorkspaces))
  .get("/workspaces/:workspaceId", (c) => {
    const workspace = mockWorkspaces.find((item) => item.id === c.req.param("workspaceId"));
    return workspace ? c.json(workspace) : c.json({ error: "not_found" }, 404);
  })

  .get("/threads", (c) => {
    const workspaceId = c.req.query("workspaceId");
    return c.json(
      workspaceId ? mockThreads.filter((item) => item.workspaceId === workspaceId) : mockThreads,
    );
  })
  .get("/threads/:threadId", (c) => {
    const thread = mockThreads.find((item) => item.id === c.req.param("threadId"));
    return thread ? c.json(thread) : c.json({ error: "not_found" }, 404);
  })
  .get("/threads/:threadId/messages", (c) =>
    c.json(mockMessages.filter((item) => item.threadId === c.req.param("threadId"))),
  )
  .get("/threads/:threadId/spec", (c) => {
    const spec = mockSpecs.find((item) => item.threadId === c.req.param("threadId"));
    return spec ? c.json(spec) : c.json(null);
  })
  .get("/threads/:threadId/plan", (c) => {
    const plan = mockPlans.find((item) => item.threadId === c.req.param("threadId"));
    return plan ? c.json(plan) : c.json(null);
  })

  .get("/tasks", (c) => {
    const threadId = c.req.query("threadId");
    return c.json(threadId ? mockTasks.filter((item) => item.threadId === threadId) : mockTasks);
  })
  .get("/tasks/:taskId", (c) => {
    const task = mockTasks.find((item) => item.id === c.req.param("taskId"));
    return task ? c.json(task) : c.json({ error: "not_found" }, 404);
  })

  .get("/runs", (c) => {
    const threadId = c.req.query("threadId");
    return c.json(threadId ? mockRuns.filter((item) => item.threadId === threadId) : mockRuns);
  })
  .get("/runs/:runId/events", (c) =>
    c.json(mockRunEvents.filter((item) => item.runId === c.req.param("runId"))),
  )

  .get("/artifacts", (c) => {
    const threadId = c.req.query("threadId");
    return c.json(
      threadId ? mockArtifacts.filter((item) => item.threadId === threadId) : mockArtifacts,
    );
  })

  .get("/memories", (c) => {
    const workspaceId = c.req.query("workspaceId");
    return c.json(
      workspaceId ? mockMemories.filter((item) => item.workspaceId === workspaceId) : mockMemories,
    );
  })

  .get("/approvals", (c) => {
    const workspaceId = c.req.query("workspaceId");
    const status = c.req.query("status");
    let rows = mockApprovals.slice();
    if (workspaceId) rows = rows.filter((item) => item.workspaceId === workspaceId);
    if (status) rows = rows.filter((item) => item.status === status);
    return c.json(rows);
  })

  .get("/files", (c) => c.json(mockFileTree))
  .get("/files/content", (c) => {
    const path = c.req.query("path");
    const file = mockFileContents.find((item) => item.path === path) ?? mockFileContents[0];
    return file ? c.json(file) : c.json({ error: "not_found" }, 404);
  })

  .get("/terminal", (c) => c.json({ lines: mockTerminalLines }))
  .get("/harnesses", (c) => c.json(mockHarnesses));
