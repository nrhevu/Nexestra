import {
  type Agent,
  CreateTaskRequestSchema,
  DispatchTaskRequestSchema,
  ReorderTasksRequestSchema,
  UpdateTaskRequestSchema,
  UpdateTaskStatusRequestSchema,
  VerifyTaskRequestSchema,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { badRequest, body, required, requireQuery } from "../errors.js";
import type { ExecutionRuntime } from "../execution/runtime.js";

export function taskRoutes(store: NexestraStore, execution: ExecutionRuntime) {
  return (
    new Hono()
      .get("/", (c) => {
        const threadId = requireQuery(c, "threadId");
        required(store.getThread(threadId), "thread");
        return c.json(store.listTasks(threadId));
      })

      .post("/", async (c) => {
        const input = await body(c, CreateTaskRequestSchema);
        const thread = required(store.getThread(input.threadId), "thread");
        const agent = input.agentId
          ? validateWorkerAgent(store, thread.workspaceId, input.agentId)
          : null;
        return c.json(
          store.createTask({
            ...input,
            ...(agent
              ? {
                  assignedHarness: agent.harness,
                  harnessConfig: {
                    ...input.harnessConfig,
                    ...(agent.model ? { model: agent.model } : {}),
                  },
                }
              : {}),
          }),
          201,
        );
      })

      // Registered before `/:taskId` so the literal path wins.
      .post("/reorder", async (c) => {
        const input = await body(c, ReorderTasksRequestSchema);
        required(store.getThread(input.threadId), "thread");
        return c.json(store.reorderTasks(input.threadId, input.taskIds));
      })

      .get("/:taskId", (c) => c.json(required(store.getTask(c.req.param("taskId")), "task")))

      .patch("/:taskId", async (c) => {
        const id = c.req.param("taskId");
        const task = required(store.getTask(id), "task");
        const patch = await body(c, UpdateTaskRequestSchema);
        const agent = patch.agentId
          ? validateWorkerAgent(store, task.workspaceId, patch.agentId)
          : null;
        return c.json(
          store.updateTask(id, {
            ...patch,
            assignedHarness: patch.assignedHarness ?? undefined,
            ...(agent
              ? {
                  assignedHarness: agent.harness,
                  harnessConfig: {
                    ...patch.harnessConfig,
                    ...(agent.model ? { model: agent.model } : {}),
                  },
                }
              : {}),
          }),
        );
      })

      .post("/:taskId/status", async (c) => {
        const id = c.req.param("taskId");
        required(store.getTask(id), "task");
        const input = await body(c, UpdateTaskStatusRequestSchema);
        return c.json(store.updateTaskStatus(id, input.status, input.order));
      })

      /**
       * Run one task now, out of band of the scheduler.
       *
       * With no `kind` this runs the whole pipeline for the task (execute →
       * review → verify → commit); `kind: "review"` or `"verify"` runs a single
       * run of that kind, which is what the Master's `dispatch_task` asks for.
       */
      .post("/:taskId/dispatch", async (c) => {
        const id = c.req.param("taskId");
        required(store.getTask(id), "task");
        const input = await body(c, DispatchTaskRequestSchema);
        return c.json(
          await execution.orchestrator.dispatch(id, {
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.harness ? { harness: input.harness } : {}),
            ...(input.instructions ? { instructions: input.instructions } : {}),
          }),
        );
      })

      /** Run the task's acceptance criteria in its worktree and record evidence. */
      .post("/:taskId/verify", async (c) => {
        const id = c.req.param("taskId");
        required(store.getTask(id), "task");
        const input = await body(c, VerifyTaskRequestSchema);
        return c.json(await execution.orchestrator.runVerification(id, input.criterionIds));
      })

      .delete("/:taskId", (c) => {
        const id = c.req.param("taskId");
        required(store.getTask(id), "task");
        store.deleteTask(id);
        return c.body(null, 204);
      })
  );
}

type WorkerAgent = Agent & { harness: "codex" | "opencode" };

function validateWorkerAgent(
  store: NexestraStore,
  workspaceId: string,
  agentId: string,
): WorkerAgent {
  const agent = required(store.getAgent(agentId), "agent");
  if (agent.workspaceId !== workspaceId || agent.harness === "nexestra" || !agent.enabled) {
    throw badRequest("Select an enabled Codex or OpenCode agent from this workspace.");
  }
  return { ...agent, harness: agent.harness };
}
