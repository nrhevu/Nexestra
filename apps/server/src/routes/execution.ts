/**
 * `/api/threads/:id/execution/*` — driving the orchestrator (M6).
 *
 * Every one of these routes answers with an `ExecutionStatus` and nothing
 * else: whatever they changed already reaches the browser as store events
 * (`run.recorded`, `task.status_changed`, `orchestrator.*`), so the response
 * only has to say where the loop stands now.
 *
 * Mounted on the same `/threads` base as `threadRoutes`, after it, so the two
 * files stay separable while the URLs read as one resource.
 */
import { ExecutionActionSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { badRequest, conflict, required } from "../errors.js";
import type { ExecutionRuntime } from "../execution/runtime.js";

export function executionRoutes(store: NexestraStore, execution: ExecutionRuntime) {
  const thread = (id: string) => required(store.getThread(id), "thread");

  return new Hono()
    .get("/:threadId/execution/status", (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(execution.status(id));
    })

    .post("/:threadId/execution/:action", async (c) => {
      const id = c.req.param("threadId");
      thread(id);

      const parsed = ExecutionActionSchema.safeParse(c.req.param("action"));
      if (!parsed.success) {
        throw badRequest(`unknown execution action "${c.req.param("action")}"`, {
          allowed: ExecutionActionSchema.options,
        });
      }

      if (parsed.data === "start" && !execution.available) {
        throw conflict(
          "no harness adapter is available in this process — install Codex or OpenCode, " +
            "or turn on the simulated harness in Settings",
        );
      }

      switch (parsed.data) {
        case "start":
          return c.json(await execution.start(id));
        case "pause":
          return c.json(await execution.pause(id));
        case "resume":
          return c.json(await execution.resume(id));
        case "cancel":
          return c.json(await execution.cancel(id));
        default:
          throw badRequest("unreachable");
      }
    });
}
