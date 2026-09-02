import { MasterSendRequestSchema } from "@nexestra/core";
import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { body, conflict, required } from "../errors.js";
import type { MasterRunner } from "../master/runner.js";

/**
 * `/api/threads/:threadId/master/*` — driving the Master.
 *
 * `send` is deliberately fire-and-forget: it validates, queues the turn and
 * answers `202` with a `turnId`. The turn itself streams over `/ws` as
 * `master.*` events, so no HTTP request is ever held open for the length of a
 * model call, and a browser that reloads mid-turn rejoins by subscribing
 * rather than by retrying.
 *
 * Mounted on the same `/threads` base as `threadRoutes`, after it, so the two
 * files stay separable while the URLs read as one resource.
 */
export function masterRoutes(store: NexestraStore, runner: MasterRunner) {
  const thread = (id: string) => required(store.getThread(id), "thread");

  return new Hono()
    .post("/:threadId/master/send", async (c) => {
      const id = c.req.param("threadId");
      thread(id);
      const input = await body(c, MasterSendRequestSchema);

      if (runner.isBusy(id) && input.kind === "user_message") {
        throw conflict("the Master is still working on this thread", { threadId: id });
      }

      const { turnId } = runner.send(id, input);
      return c.json({ threadId: id, turnId, accepted: true as const }, 202);
    })

    .post("/:threadId/master/cancel", (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json({ threadId: id, cancelled: runner.cancel(id) });
    })

    .get("/:threadId/master/state", async (c) => {
      const id = c.req.param("threadId");
      thread(id);
      return c.json(await runner.state(id));
    });
}
