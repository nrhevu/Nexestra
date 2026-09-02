import { CreateApprovalRequestSchema, ResolveApprovalRequestSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body, conflict, required } from "../errors.js";
import type { MasterRunner } from "../master/runner.js";

export function approvalRoutes(store: NexestraStore, runner: MasterRunner) {
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
      const resolved = store.resolveApproval(id, input);

      // A Master turn suspended on this approval resumes here, so Approve /
      // Reject in the sidebar is the only gesture the user needs: the same
      // click both records the decision and unblocks the agent.
      if (resolved.status === "approved" || resolved.status === "rejected") {
        await runner.resumeApproval(resolved.threadId, resolved.id, resolved.status);
      }
      return c.json(resolved);
    });
}
