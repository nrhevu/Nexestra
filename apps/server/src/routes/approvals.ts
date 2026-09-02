import { CreateApprovalRequestSchema, ResolveApprovalRequestSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body, conflict, required } from "../errors.js";

export function approvalRoutes(store: NexestraStore) {
  return new Hono()
    .get("/", (c) =>
      c.json(
        store.listApprovals({
          workspaceId: c.req.query("workspaceId"),
          threadId: c.req.query("threadId"),
          status: c.req.query("status"),
        }),
      ),
    )

    .post("/", async (c) => {
      const input = await body(c, CreateApprovalRequestSchema);
      required(store.getThread(input.threadId), "thread");
      return c.json(store.createApproval(input), 201);
    })

    .get("/:approvalId", (c) =>
      c.json(required(store.getApproval(c.req.param("approvalId")), "approval")),
    )

    .post("/:approvalId/resolve", async (c) => {
      const id = c.req.param("approvalId");
      const approval = required(store.getApproval(id), "approval");
      if (approval.status !== "pending") {
        throw conflict(`approval ${id} is already ${approval.status}`, {
          status: approval.status,
        });
      }
      const input = await body(c, ResolveApprovalRequestSchema);
      return c.json(store.resolveApproval(id, input));
    });
}
