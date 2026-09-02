import {
  CreateMessageRequestSchema,
  CreateThreadRequestSchema,
  UpdateThreadRequestSchema,
  UpsertPlanRequestSchema,
  UpsertSpecRequestSchema,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body, required } from "../errors.js";

export function threadRoutes(store: NexestraStore) {
  const thread = (id: string) => required(store.getThread(id), "thread");

  return new Hono()
    .get("/", (c) => c.json(store.listThreads(c.req.query("workspaceId"))))

    .post("/", async (c) => {
      const input = await body(c, CreateThreadRequestSchema);
      required(store.getWorkspace(input.workspaceId), "workspace");
      return c.json(store.createThread(input), 201);
    })

    .get("/:threadId", (c) => c.json(thread(c.req.param("threadId"))))

    .patch("/:threadId", async (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(store.updateThread(id, await body(c, UpdateThreadRequestSchema)));
    })

    .get("/:threadId/messages", (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(store.listMessages(id));
    })

    .post("/:threadId/messages", async (c) => {
      const id = c.req.param("threadId");
      thread(id);
      const input = await body(c, CreateMessageRequestSchema);
      return c.json(store.addMessage({ threadId: id, ...input }), 201);
    })

    .get("/:threadId/spec", (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(store.getSpec(id));
    })

    .put("/:threadId/spec", async (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(store.upsertSpec(id, await body(c, UpsertSpecRequestSchema)));
    })

    .get("/:threadId/plan", (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(store.getPlan(id));
    })

    .put("/:threadId/plan", async (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(store.upsertPlan(id, await body(c, UpsertPlanRequestSchema)));
    })

    .get("/:threadId/events", (c) => {
      const id = c.req.param("threadId");
      thread(id);
      const after = c.req.query("afterSeq");
      return c.json(
        store.readThreadEvents(id, after === undefined ? undefined : Number.parseInt(after, 10)),
      );
    });
}
