import {
  CreateMemoryRequestSchema,
  LinkMemoriesRequestSchema,
  MemoryLinkTypeSchema,
  UpdateMemoryRequestSchema,
} from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { badRequest, body, required } from "../errors.js";

export function memoryRoutes(store: NexestraStore) {
  return new Hono()
    .get("/", (c) =>
      c.json(
        store.listMemories({
          workspaceId: c.req.query("workspaceId"),
          threadId: c.req.query("threadId"),
        }),
      ),
    )

    .post("/", async (c) => {
      const input = await body(c, CreateMemoryRequestSchema);
      required(store.getWorkspace(input.workspaceId), "workspace");
      return c.json(store.upsertMemory({ ...input, authoredBy: input.authoredBy ?? "user" }), 201);
    })

    .get("/:memoryId", (c) => c.json(required(store.getMemory(c.req.param("memoryId")), "memory")))

    .patch("/:memoryId", async (c) => {
      const id = c.req.param("memoryId");
      const current = required(store.getMemory(id), "memory");
      const patch = await body(c, UpdateMemoryRequestSchema);
      return c.json(
        store.upsertMemory({
          id,
          workspaceId: current.workspaceId,
          threadId: current.threadId,
          type: patch.type ?? current.type,
          title: patch.title ?? current.title,
          content: patch.content ?? current.content,
          tags: patch.tags ?? current.tags,
          source: patch.source ?? current.source,
          authoredBy: patch.authoredBy ?? current.authoredBy,
        }),
      );
    })

    .delete("/:memoryId", (c) => {
      const id = c.req.param("memoryId");
      required(store.getMemory(id), "memory");
      store.deleteMemory(id);
      return c.body(null, 204);
    })

    .post("/:memoryId/links", async (c) => {
      const id = c.req.param("memoryId");
      required(store.getMemory(id), "memory");
      const input = await body(c, LinkMemoriesRequestSchema);
      required(store.getMemory(input.targetId), "target memory");
      return c.json(store.linkMemories(id, input), 201);
    })

    .delete("/:memoryId/links/:targetId", (c) => {
      const id = c.req.param("memoryId");
      required(store.getMemory(id), "memory");
      const parsed = MemoryLinkTypeSchema.safeParse(c.req.query("type"));
      if (!parsed.success) {
        throw badRequest(
          `query parameter "type" must be one of ${MemoryLinkTypeSchema.options.join(", ")}`,
        );
      }
      return c.json(store.unlinkMemories(id, c.req.param("targetId"), parsed.data));
    });
}
