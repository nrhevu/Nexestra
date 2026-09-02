import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import { required, requireQuery } from "../errors.js";

/** Runs are read-only over HTTP in M1; the orchestrator writes them (M4). */
export function runRoutes(store: NexestraStore) {
  return new Hono()
    .get("/", (c) => {
      const threadId = requireQuery(c, "threadId");
      required(store.getThread(threadId), "thread");
      return c.json(store.listRuns(threadId));
    })

    .get("/:runId", (c) => c.json(required(store.getRun(c.req.param("runId")), "run")))

    .get("/:runId/events", (c) => {
      const runId = c.req.param("runId");
      required(store.getRun(runId), "run");
      const after = c.req.query("afterSeq");
      return c.json(
        store.listRunEvents(runId, after === undefined ? undefined : Number.parseInt(after, 10)),
      );
    });
}
