import type { NexestraStore } from "@nexestra/storage";
import { Hono } from "hono";
import type { ExecutionRuntime } from "../execution/runtime.js";

/**
 * `GET /api/harnesses` — what this machine can actually drive.
 *
 * The results come from each registered adapter's `discover()`, which shells
 * out, so they are cached by the registry. `?refresh=1` re-runs detection,
 * which is what the Settings surface's refresh button calls after the user has
 * installed something.
 */
export function harnessRoutes(_store: NexestraStore, execution: ExecutionRuntime) {
  return new Hono().get("/", async (c) => {
    const refresh = c.req.query("refresh");
    const list =
      refresh === "1" || refresh === "true"
        ? execution.registry.refresh()
        : execution.registry.list();
    return c.json(await list);
  });
}
