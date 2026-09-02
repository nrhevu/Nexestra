import {
  CreateTaskRequestSchema,
  ReorderTasksRequestSchema,
  UpdateTaskRequestSchema,
  UpdateTaskStatusRequestSchema,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body, required, requireQuery } from "../errors.js";

export function taskRoutes(store: NexestraStore) {
  return (
    new Hono()
      .get("/", (c) => {
        const threadId = requireQuery(c, "threadId");
        required(store.getThread(threadId), "thread");
        return c.json(store.listTasks(threadId));
      })

      .post("/", async (c) => {
        const input = await body(c, CreateTaskRequestSchema);
        required(store.getThread(input.threadId), "thread");
        return c.json(store.createTask(input), 201);
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
        required(store.getTask(id), "task");
        const patch = await body(c, UpdateTaskRequestSchema);
        return c.json(
          store.updateTask(id, {
            ...patch,
            assignedHarness: patch.assignedHarness ?? undefined,
          }),
        );
      })

      .post("/:taskId/status", async (c) => {
        const id = c.req.param("taskId");
        required(store.getTask(id), "task");
        const input = await body(c, UpdateTaskStatusRequestSchema);
        return c.json(store.updateTaskStatus(id, input.status, input.order));
      })

      .delete("/:taskId", (c) => {
        const id = c.req.param("taskId");
        required(store.getTask(id), "task");
        store.deleteTask(id);
        return c.body(null, 204);
      })
  );
}
